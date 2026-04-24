import { spawn } from 'child_process';
import type { ToolDef } from '../types.js';
import type { PermissionResult, ToolPermissionContext } from '../permissions/types.js';
import { isContentAllowed, isContentDenied } from '../permissions/checker.js';
import { checkCapability } from '../yomeSkills/capabilityGuard.js';

const MAX_OUTPUT = 20_000;

// ── Skill-aware command interception ────────────────────────────────
//
// Per spec §7.6 + §11.4-D, when an installed skill needs an OS capability
// (fs:read, fs:write, applescript, network, ...) the agent is supposed to
// route through a guarded entry point so we can deny commands the user has
// not granted that capability for.
//
// Convention chosen for v1 (intentionally narrow — easy to remove later):
//
//   yome-skill <slug> <capability> -- <real shell command>
//
// Example the LLM is taught to emit:
//
//   yome-skill @yome/ppt fs:write -- /usr/bin/osascript -e '...'
//
// We:
//   1. Parse the prefix (first 4 tokens up to the literal `--`).
//   2. Call capabilityGuard.checkCapability(slug, cap). On deny, return a
//      stable error string that includes the cap so the LLM can pick a
//      different action.
//   3. On allow, hand the remaining tokens to /bin/sh -c as a normal
//      command. The skill binary itself takes over from there.
//
// All other commands fall through to plain shell execution — the agent's
// existing behaviour is preserved byte-for-byte.

interface SkillInvocation {
  slug: string;
  capability: string;
  shellCommand: string;
}

const SKILL_PREFIX = 'yome-skill';

function parseSkillInvocation(command: string): SkillInvocation | null {
  // Cheap fast-path so we don't tokenise every bash command.
  const trimmed = command.trimStart();
  if (!trimmed.startsWith(SKILL_PREFIX + ' ')) return null;

  // We look for the literal ` -- ` separator so callers can pass arbitrary
  // shell after it (including unquoted spaces). The header tokens are
  // simple ASCII (slug = `@owner/name`, cap = `verb:noun`), so a regex
  // suffices for the head and we keep the tail as-is.
  const sep = ' -- ';
  const sepIdx = trimmed.indexOf(sep);
  if (sepIdx < 0) return null;

  const head = trimmed.slice(SKILL_PREFIX.length, sepIdx).trim();
  const tail = trimmed.slice(sepIdx + sep.length);
  if (!tail.trim()) return null;

  const headParts = head.split(/\s+/);
  if (headParts.length !== 2) return null;
  const [slug, capability] = headParts;

  // Conservative validation — refuse anything that looks like an injection
  // attempt before we even consult the cap guard.
  if (!/^@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(slug)) return null;
  if (!/^[a-z]+(?::[a-z*]+)?$/.test(capability)) return null;

  return { slug, capability, shellCommand: tail };
}

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
    let command = input.command as string;
    const timeout = ((input.timeout as number) || 30) * 1000;

    // Skill-aware intercept (see SKILL_PREFIX comment near top).
    const inv = parseSkillInvocation(command);
    if (inv) {
      const decision = checkCapability(inv.slug, inv.capability);
      if (!decision.allowed) {
        return [
          `[capability denied]`,
          `skill: ${inv.slug}`,
          `capability: ${inv.capability}`,
          `reason: ${decision.reason ?? 'unknown'}`,
          ``,
          `Pick a different action, or ask the user to run:`,
          `  yome skill perms ${inv.slug} --grant=${inv.capability}`,
        ].join('\n');
      }
      // Allowed — strip the prefix and run the underlying command.
      command = inv.shellCommand;
    }

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
