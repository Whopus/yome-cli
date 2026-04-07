import { spawn } from 'child_process';
import type { ToolDef } from '../types.js';
import type { PermissionResult, ToolPermissionContext } from '../permissions/types.js';
import { isContentAllowed, isContentDenied } from '../permissions/checker.js';

const MAX_OUTPUT = 20_000;

function runCommand(command: string, timeout: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn('sh', ['-c', command], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, timeout);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
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

export const bashTool: ToolDef = {
  name: 'Bash',
  description: 'Execute a shell command and return its output. Commands run in the current working directory.',
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

    const { stdout, stderr, exitCode } = await runCommand(command, timeout);

    if (exitCode === 0) {
      const result = stdout.trim();
      if (result.length > MAX_OUTPUT) {
        return result.slice(0, MAX_OUTPUT) + `\n\n[Output truncated at ${MAX_OUTPUT} chars]`;
      }
      return result || '(no output)';
    }

    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
    return `Exit code: ${exitCode}\n${output}`;
  },
};
