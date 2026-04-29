// Daemon-side Agent runner — "non-interactive" mode.
//
// Reuses cli/src/agent.ts wholesale. The trick is in WHICH callbacks we
// register:
//   - onAskPermission → auto-deny (with feedback to the LLM) instead of
//     prompting a human
//   - setAskUserHandler is NOT called → AskUser tool short-circuits per
//     its own headless contract (see tools/askUser.ts)
//   - autoAllow / autoDeny rules layered into the permission context
//   - all tool_use / tool_result / text_delta written to a per-run jsonl
//     audit log
//
// The agent's own MAX_ITERATIONS=30 (loops/simple.ts) is the iteration
// safety net. Wall-time budget is enforced by the parent process spawning
// the runner with a kill timer (see triggers/cron.ts).

import { Agent } from '../agent.js';
import type { YomeConfig } from '../config.js';
import type { AskPermissionResult } from '../tools/index.js';
import { appendLog, openTaskLog } from './log.js';

export interface DaemonTaskSpec {
  taskId: string;
  prompt: string;
  cwd?: string;
  /** Permission allowlist, e.g. ['Read', 'Write', 'Yome(@yome/fs:*)']. */
  autoAllow?: string[];
  /** Permission denylist (overrides allowlist), e.g. ['Bash(rm:*)']. */
  autoDeny?: string[];
}

export interface DaemonTaskResult {
  ok: boolean;
  finalText: string;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  logFile: string;
  error?: string;
}

/**
 * Default safety denylist applied to every daemon task on top of the
 * user's autoDeny.
 *
 * We deliberately keep this list TINY. Daemon tasks already require an
 * explicit `--allow Bash(*)` to use Bash at all, so a second layer of
 * "no rm, no chmod" was over-cautious and broke common scripted
 * workflows (Agent writes a shell script then can't `chmod +x` it,
 * Agent does `rm /tmp/somefile` and gets blocked, etc.).
 *
 * We only block the patterns that are catastrophic and cannot be
 * undone: `sudo` (privilege escalation), and `rm -rf` against root or
 * the user's home. Garden-variety `rm somefile` is allowed; if you don't
 * want the agent deleting files at all, use `--deny "Bash(rm:*)"` per
 * task.
 */
const DEFAULT_DAEMON_DENY = [
  'Bash(sudo:*)',
  'Bash(rm -rf /:*)',
  'Bash(rm -rf /*:*)',
  'Bash(rm -rf ~:*)',
  'Bash(rm -rf ~/:*)',
  'Bash(rm -rf $HOME:*)',
  'Bash(rm -rf $HOME/:*)',
];

export async function runDaemonTask(
  config: YomeConfig,
  spec: DaemonTaskSpec,
): Promise<DaemonTaskResult> {
  const runTs = Date.now();
  const logFile = openTaskLog(spec.taskId, runTs);

  appendLog(logFile, {
    type: 'run_start',
    taskId: spec.taskId,
    prompt: spec.prompt,
    autoAllow: spec.autoAllow ?? [],
    autoDeny: spec.autoDeny ?? [],
    cwd: spec.cwd ?? process.cwd(),
    model: config.model,
  });

  // Optional cwd switch — many tasks expect to read/write under a specific
  // directory, but we don't want to pollute the daemon's own cwd.
  const originalCwd = process.cwd();
  if (spec.cwd) {
    try { process.chdir(spec.cwd); } catch (e) {
      appendLog(logFile, { type: 'error', stage: 'chdir', message: String(e) });
    }
  }

  const agent = new Agent(config);

  for (const rule of spec.autoAllow ?? []) {
    agent.addPermissionRule(rule, 'allow', 'session');
  }
  for (const rule of [...DEFAULT_DAEMON_DENY, ...(spec.autoDeny ?? [])]) {
    agent.addPermissionRule(rule, 'deny', 'session');
  }

  const onAskPermission = async (
    toolName: string,
    message: string,
    input: Record<string, unknown>,
  ): Promise<AskPermissionResult> => {
    appendLog(logFile, {
      type: 'permission_denied_auto',
      toolName,
      message,
      input: redactForLog(input),
    });
    return {
      decision: 'deny',
      feedback:
        `Daemon mode: '${toolName}' is not in this task's autoAllow list. ` +
        `Either complete the task with a different tool or stop and explain why.`,
    };
  };

  let finalText = '';
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let error: string | undefined;

  try {
    await agent.run(spec.prompt, {
      onTextDelta: (text) => {
        finalText += text;
        // We don't log every delta (too chatty); the run_end entry has the
        // full assembled text.
      },
      onToolUse: (name, input) => {
        toolCalls++;
        appendLog(logFile, { type: 'tool_use', name, input: redactForLog(input) });
      },
      onToolResult: (name, result) => {
        appendLog(logFile, {
          type: 'tool_result',
          name,
          result: result.length > 4_000 ? result.slice(0, 4_000) + '…[truncated]' : result,
        });
      },
      onDone: (usage) => {
        inputTokens = usage.inputTokens;
        outputTokens = usage.outputTokens;
      },
      onError: (err) => {
        error = err?.message ?? String(err);
        appendLog(logFile, { type: 'error', stage: 'agent_loop', message: error });
      },
      onAskPermission,
    });
  } catch (e: any) {
    error = e?.message ?? String(e);
    appendLog(logFile, { type: 'error', stage: 'unhandled', message: error });
  } finally {
    if (spec.cwd) {
      try { process.chdir(originalCwd); } catch { /* noop */ }
    }
  }

  const durationMs = Date.now() - runTs;
  const ok = !error;
  appendLog(logFile, {
    type: 'run_end',
    ok,
    durationMs,
    toolCalls,
    inputTokens,
    outputTokens,
    finalText: finalText.length > 4_000 ? finalText.slice(0, 4_000) + '…[truncated]' : finalText,
    error,
  });

  return {
    ok,
    finalText: finalText.trim(),
    toolCalls,
    inputTokens,
    outputTokens,
    durationMs,
    logFile,
    error,
  };
}

/**
 * Strip obvious secrets from tool input before writing to disk. The audit
 * log lives in plaintext so we should not leak API keys / tokens that the
 * agent might pass through. Best-effort — not a security boundary.
 */
function redactForLog(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (/key|token|secret|password|authorization/i.test(k)) {
      out[k] = '[redacted]';
    } else if (typeof v === 'string' && v.length > 2_000) {
      out[k] = v.slice(0, 2_000) + '…[truncated]';
    } else {
      out[k] = v;
    }
  }
  return out;
}
