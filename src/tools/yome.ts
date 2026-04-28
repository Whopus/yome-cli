// cli/src/tools/yome.ts
//
// `Yome` — agent tool that runs an installed yome hub-skill command.
//
// This tool is the ONLY correct way to invoke installed skills (xl, ppt,
// cal, fs, rem, …). It accepts the same shorthand a human would type
// (`xl books`, `ppt new ~/Desktop/x.pptx`, `xl batch <<EOF…EOF`) and
// dispatches through the yome agentic kernel — same path the macOS app
// uses, with capability gating, AppleScript template render, argv
// parsing, and `--help` at three levels (global / domain / action).
//
// ── Why this is split from `Bash` ───────────────────────────────────
//
// Bash used to call `tryKernel()` *implicitly* before falling back to
// /bin/sh. That was confusing — the same `Bash(xl books)` call could be
// running AppleScript templates or shelling out, and when something
// went wrong (e.g. a stale install in ~/.yome/skills) it was hard for
// the user to tell which path actually executed.
//
// Now the routing is explicit:
//
//   * `Yome` → only the yome kernel, no shell fallback. If the command
//     is not a recognised hub-skill invocation, the tool returns an
//     error explaining why instead of silently passing it to /bin/sh.
//
//   * `Bash` → only system shell. No kernel intercept, no surprises.
//
// The agent is expected to pick the right tool from the start.

import type { ToolDef } from '../types.js';
import { tryKernel } from '../skills/runner/kernel.js';

const MAX_OUTPUT = 20_000;

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

export const yomeTool: ToolDef = {
  name: 'Yome',
  description:
    'Invoke an installed yome hub-skill command (xl, ppt, cal, fs, rem, …). ' +
    'Pass the command line exactly as a human would type it: e.g. ' +
    '`xl books`, `xl sheets`, `ppt new ~/Desktop/x.pptx`, `xl find 客户`. ' +
    'Supports `--help` at every level: `yome-skills` (list installed), ' +
    '`<domain> --help` (list actions), `<domain> <action> --help` (action args), ' +
    'plus `<domain> batch` for stdin-fed multi-command runs. ' +
    'This tool ONLY runs hub-skill commands — it does NOT fall back to /bin/sh. ' +
    'For real shell operations (ls, cat, git, mkdir, …) use the Bash tool.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'The skill command line. First token must be an installed skill domain ' +
          '(see `yome-skills` for the list). Compound shell (pipes, redirects, `;`) ' +
          'is not supported here — use Bash for that.',
      },
    },
    required: ['command'],
  },
  isReadOnly() { return false; },
  validateInput(input) {
    if (typeof input.command !== 'string' || !input.command.trim()) {
      return { valid: false, error: 'command is required' };
    }
    return { valid: true };
  },
  async execute(input) {
    const command = (input.command as string).trim();
    const k = await tryKernel(command);
    if (!k.handled) {
      return (
        `Exit code: 2\n` +
        `Yome tool: command not recognised as a hub-skill invocation.\n` +
        `  command: ${command}\n` +
        `Possible causes:\n` +
        `  - first token is not an installed skill domain (run \`yome-skills\` to list)\n` +
        `  - first token is a reserved system command (ls, git, …) — use Bash for shell ops\n` +
        `  - command is compound (pipes, &&, ;, redirects) — Yome runs single skill calls only\n` +
        `If you intended a real shell command, retry with the Bash tool.`
      );
    }
    return formatOutput(k.stdout, k.stderr, k.exitCode);
  },
};
