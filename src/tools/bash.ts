import { spawn } from 'child_process';
import type { ToolDef } from '../types.js';
import type { PermissionResult, ToolPermissionContext } from '../permissions/types.js';
import { isContentAllowed, isContentDenied } from '../permissions/checker.js';

const MAX_OUTPUT = 20_000;
// Cap per-stream buffer to 4× the output limit. Without this, a runaway
// command (`cat /dev/urandom`, broken `npm run build`) accumulates an
// unbounded JS string in memory before we ever get to truncate it.
// This is the difference between "tool reports truncated" and "node
// process gets OOM-killed mid-session".
const MAX_BUFFER = MAX_OUTPUT * 4;

// ── Pure system shell ─────────────────────────────────────────────
//
// Bash used to call `tryKernel()` first to opportunistically intercept
// hub-skill invocations like `xl books`. That made routing implicit and
// hard to debug — it was never obvious whether a given Bash call had
// actually hit /bin/sh or had been redirected into AppleScript.
//
// The kernel intercept now lives behind a separate `Yome` tool
// (cli/src/tools/yome.ts). Bash is once again *only* a system shell;
// the agent picks the right tool up-front based on intent.

function runShell(command: string, timeout: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn('sh', ['-c', command], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, timeout);

    // Stream-side cap: once a buffer hits MAX_BUFFER chars we stop
    // accumulating from that pipe. The child can keep running (we don't
    // want to break commands that legitimately produce a lot of output —
    // tests, builds, etc.) but the agent's memory stays bounded.
    proc.stdout.on('data', (data) => {
      if (stdoutOverflow) return;
      stdout += data.toString();
      if (stdout.length > MAX_BUFFER) {
        stdout = stdout.slice(0, MAX_BUFFER);
        stdoutOverflow = true;
      }
    });
    proc.stderr.on('data', (data) => {
      if (stderrOverflow) return;
      stderr += data.toString();
      if (stderr.length > MAX_BUFFER) {
        stderr = stderr.slice(0, MAX_BUFFER);
        stderrOverflow = true;
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (stdoutOverflow) stdout += `\n[stdout capped at ${MAX_BUFFER} chars]`;
      if (stderrOverflow) stderr += `\n[stderr capped at ${MAX_BUFFER} chars]`;
      if (killed) {
        resolve({ stdout, stderr: `Command timed out after ${timeout / 1000}s`, exitCode: 124 });
      } else {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: err.message, exitCode: 1 });
    });
  });
}

function formatOutput(stdout: string, stderr: string, exitCode: number): string {
  if (exitCode === 0) {
    const result = stdout.trim();
    if (result.length > MAX_OUTPUT) {
      return result.slice(0, MAX_OUTPUT) + `\n\n[Output truncated at ${MAX_OUTPUT} chars]`;
    }
    return result || '(no output)';
  }
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
  return `Exit code: ${exitCode}\n${output}`;
}

export const bashTool: ToolDef = {
  name: 'Bash',
  description:
    'Execute a system shell command via /bin/sh and return its output. ' +
    'Use this for real shell operations: ls, cat, mkdir, git, curl, build/test runners, pipes, redirects, etc. ' +
    'Commands run in the current working directory. ' +
    'This tool does NOT route to yome hub skills — to invoke an installed skill (xl, ppt, cal, fs, rem, …) ' +
    'use the dedicated `Yome` tool instead.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
    },
    required: ['command'],
  },
  isReadOnly() { return false; },
  checkPermissions(input: Record<string, unknown>, ctx: ToolPermissionContext): PermissionResult {
    const command = (input.command as string) ?? '';
    if (isContentDenied(ctx, 'Bash', command)) {
      return { behavior: 'deny', message: `Command denied by permission rule: ${command}` };
    }
    if (isContentAllowed(ctx, 'Bash', command)) {
      return { behavior: 'allow' };
    }
    return { behavior: 'passthrough', message: `Allow Bash to run: ${command}?` };
  },
  validateInput(input) {
    if (typeof input.command !== 'string' || !input.command.trim()) {
      return { valid: false, error: 'command is required' };
    }
    return { valid: true };
  },
  async execute(input) {
    const command = input.command as string;
    const timeout = ((input.timeout as number) || 30) * 1000;

    const { stdout, stderr, exitCode } = await runShell(command, timeout);
    return formatOutput(stdout, stderr, exitCode);
  },
};
