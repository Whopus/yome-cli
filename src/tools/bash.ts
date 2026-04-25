import { spawn } from 'child_process';
import type { ToolDef } from '../types.js';
import type { PermissionResult, ToolPermissionContext } from '../permissions/types.js';
import { isContentAllowed, isContentDenied } from '../permissions/checker.js';
import { tryKernel } from '../skills/runner/kernel.js';

const MAX_OUTPUT = 20_000;
// Cap per-stream buffer to 4× the output limit. Without this, a runaway
// command (`cat /dev/urandom`, broken `npm run build`) accumulates an
// unbounded JS string in memory before we ever get to truncate it.
// This is the difference between "tool reports truncated" and "node
// process gets OOM-killed mid-session".
const MAX_BUFFER = MAX_OUTPUT * 4;

// ── Yome agentic kernel intercept ─────────────────────────────────
//
// Before we hand a command off to /bin/sh we ask the yome kernel whether
// it owns the line. If `tokens[0]` matches the `domain` of an installed
// hub skill, the kernel runs the action via the same dispatcher the
// macOS app uses (with capability gating, AppleScript template render,
// argv parsing, --help) and returns a synthetic stdout/stderr/exitCode.
//
// Anything the kernel doesn't claim falls through to plain shell.
// Compound shell (pipes, &&, ;, redirects, subshells) is never intercepted.

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
    'Execute a shell command and return its output. Commands run in the current working directory. ' +
    'When the first token matches an installed hub skill domain (e.g. `ppt`), the yome agentic kernel ' +
    'intercepts the line and dispatches to the skill instead of the system shell — capability checks ' +
    'are enforced. Compound shell (pipes, &&, ;, redirects) always goes to /bin/sh.',
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

    // Try the yome kernel first.
    const k = await tryKernel(command);
    if (k.handled) {
      return formatOutput(k.stdout, k.stderr, k.exitCode);
    }

    // Otherwise, real shell.
    const { stdout, stderr, exitCode } = await runShell(command, timeout);
    return formatOutput(stdout, stderr, exitCode);
  },
};
