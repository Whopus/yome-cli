// Spawn a child `yome __run-task <id>` process and wire it up:
//   - capture stdout/stderr
//   - enforce wall-time budget (SIGTERM → SIGKILL)
//   - on exit, parse the last JSON line of stdout for real stats and
//     forward them to recordRun()
//
// Used by every trigger (cron / once / file / future calendar) so the
// behaviour is identical no matter what fired the task.

import { spawn } from 'child_process';
import type { TaskRecord, RunSummary } from '../taskStore.js';
import { recordRun } from '../taskStore.js';
import { appendLog, openTaskLog } from '../log.js';

export interface ChildRunOptions {
  taskId: string;
  yomeBinPath: string;
  task: TaskRecord;
  /** Free-form metadata appended to run_start log entry (e.g. trigger source). */
  triggerMeta?: Record<string, unknown>;
  /** Extra env vars merged into the child process. Used by triggers to inject
   *  runtime context (e.g. YOME_TASK_EXTRA_CONTEXT="[calendar event]…"). */
  extraEnv?: Record<string, string>;
  /** Called after the child exits and stats have been recorded. */
  onComplete?: (summary: RunSummary) => void;
}

const KILL_GRACE_MS = 3_000;

export function runChildTask(opts: ChildRunOptions): void {
  const { taskId, yomeBinPath, task, triggerMeta, extraEnv, onComplete } = opts;
  const runTs = Date.now();
  const logFile = openTaskLog(taskId, runTs);
  appendLog(logFile, {
    type: 'run_start',
    taskId,
    prompt: task.prompt,
    scheduledFire: true,
    ...(triggerMeta ?? {}),
  });

  const maxMs = task.maxDurationMs ?? 5 * 60_000;
  const child = spawn(
    process.execPath,
    [yomeBinPath, '__run-task', taskId],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Env merge order (later wins):
      //   1. parent process.env  (daemon's own env)
      //   2. task.env            (per-task settings stored in tasks.json,
      //                            e.g. YOME_WEB_HEADLESS=0)
      //   3. caller-provided extraEnv (trigger-injected runtime context,
      //                                e.g. YOME_TASK_EXTRA_CONTEXT)
      //   4. YOME_DAEMON_RUN_TS  (always last; sourced from this run)
      env: {
        ...process.env,
        ...(task.env ?? {}),
        ...(extraEnv ?? {}),
        YOME_DAEMON_RUN_TS: String(runTs),
      },
      detached: false,
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => { stdout += d.toString('utf-8'); });
  child.stderr?.on('data', (d) => { stderr += d.toString('utf-8'); });

  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    appendLog(logFile, { type: 'timeout', maxMs });
    try { child.kill('SIGTERM'); } catch { /* noop */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, KILL_GRACE_MS);
  }, maxMs);

  child.on('exit', (code, signal) => {
    clearTimeout(killer);

    // The child writes a single JSON status line to stdout on success.
    // Parse the LAST non-empty line so any incidental console.log earlier
    // in the run doesn't break stats — we still get the summary.
    const stats = parseStatsFromStdout(stdout);

    const ok = code === 0 && !timedOut;
    const summary: RunSummary = {
      ts: runTs,
      ok,
      durationMs: Date.now() - runTs,
      toolCalls: stats?.toolCalls ?? 0,
      inputTokens: stats?.inputTokens ?? 0,
      outputTokens: stats?.outputTokens ?? 0,
      error: ok
        ? undefined
        : timedOut
          ? `timeout after ${maxMs}ms`
          : (stats?.error ?? `exit=${code} signal=${signal} stderr=${stderr.slice(0, 500)}`),
    };

    appendLog(logFile, {
      type: 'run_end',
      ok,
      timedOut,
      exitCode: code,
      signal,
      toolCalls: summary.toolCalls,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      stdoutTail: stdout.slice(-500),
      stderrTail: stderr.slice(-500),
    });
    recordRun(taskId, summary);
    onComplete?.(summary);
  });
}

interface ChildStats {
  ok: boolean;
  toolCalls: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

function parseStatsFromStdout(stdout: string): ChildStats | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith('{')) continue;
    try {
      const j = JSON.parse(line);
      if (typeof j === 'object' && j && 'taskId' in j && 'ok' in j) {
        return j as ChildStats;
      }
    } catch { /* not JSON, keep scanning back */ }
  }
  return null;
}
