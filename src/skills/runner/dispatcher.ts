// cli/src/skills/runner/dispatcher.ts
//
// Generic backend dispatcher for installed yome skills. Reads a skill's
// `backends/macos/manifest.json` (declarative — no JS code in the skill
// bundle) and translates an action invocation into an osascript run.
//
// A skill author publishes:
//
//   ~/.yome/skills/@owner/foo/
//     backends/macos/
//       manifest.json
//       new.applescript
//       open.applescript
//       open.poll.applescript
//       slides.applescript
//       ...
//
// `manifest.json` shape (this file is the contract):
//
//   {
//     "appBundleId":  "com.microsoft.Powerpoint",
//     "appName":      "Microsoft PowerPoint",
//     "actions": {
//       "<action>": {
//         "script":  "new.applescript",            // template file (required)
//         "args":    [ { "name", "from", "type?", "default?", "required?" } ],
//         "openViaLaunchServices": false,           // for `open` style
//         "pollScript": "open.poll.applescript",    // when openViaLaunchServices
//         "uses": [ "applescript", "fs:write" ]     // capabilities required
//       }
//     }
//   }
//
// `args[].from` is one of:
//   - "positional"      → call.positionals[0]
//   - "positional|--X"  → positional, fall back to --X flag
//   - "--X"             → call.flags["X"]
//
// The .applescript file is rendered with mustache-ish placeholders:
//   {{name}}             → raw substitution (caller must escape)
//   {{name|json}}        → JSON-stringify (safe for AppleScript string literal)
//   {{name|posix}}       → wrap in `POSIX file "..."`
//   {{name|bool}}        → `true` / `false` AppleScript literal

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  runOsascript,
  openViaLaunchServices,
  type AppleScriptResult,
} from './applescript.js';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export interface BackendArgSpec {
  name: string;
  from: string;
  type?: 'string' | 'bool' | 'number';
  default?: string | boolean | number;
  required?: boolean;
}

export interface BackendActionSpec {
  script: string;
  args?: BackendArgSpec[];
  openViaLaunchServices?: boolean;
  pollScript?: string;
  uses?: string[];
  /** Per-action timeout override in ms. */
  timeoutMs?: number;
}

export interface MacosBackendManifest {
  appBundleId?: string;
  appName?: string;
  actions: Record<string, BackendActionSpec>;
}

export interface SkillCall {
  positionals: string[];
  flags: Record<string, string | boolean | number | undefined>;
}

export interface DispatchResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ──────────────────────────────────────────────────────────────────────
// Argument resolution
// ──────────────────────────────────────────────────────────────────────

function resolveArg(spec: BackendArgSpec, call: SkillCall): string | boolean | number | null {
  const sources = spec.from.split('|').map((s) => s.trim());
  for (const src of sources) {
    if (src === 'positional') {
      const v = call.positionals[0];
      if (v !== undefined && v !== '') return v;
    } else if (src.startsWith('--')) {
      const key = src.slice(2);
      const v = call.flags[key];
      if (v !== undefined && v !== '') return v;
    }
  }
  if (spec.default !== undefined) return spec.default;
  if (spec.required) return null;
  return spec.type === 'bool' ? false : '';
}

// ──────────────────────────────────────────────────────────────────────
// Template rendering
// ──────────────────────────────────────────────────────────────────────

function isTruthy(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return v !== '' && v !== 'false' && v !== '0';
  if (typeof v === 'number') return v !== 0;
  return false;
}

// Named CSS-ish colors that map to PowerPoint-friendly RGB triples.
// Mirror of the Swift PowerPointBridge.colorToRGB lookup so cli + macos app
// behave the same when a user types `--color=red`.
const NAMED_COLORS: Record<string, [number, number, number]> = {
  black:    [0, 0, 0],
  white:    [255, 255, 255],
  red:      [255, 0, 0],
  green:    [0, 128, 0],
  blue:     [0, 0, 255],
  navy:     [0, 51, 102],
  darkblue: [0, 51, 102],
  yellow:   [255, 255, 0],
  orange:   [255, 165, 0],
  purple:   [128, 0, 128],
  pink:     [255, 192, 203],
  cyan:     [0, 255, 255],
  gray:     [128, 128, 128],
  grey:     [128, 128, 128],
};

/**
 * Parse `red` | `#003366` | `003366` | `0, 51, 102` into an AppleScript
 * RGB literal `{r, g, b}`. Returns null if the input doesn't match any of
 * those three forms — callers should treat null as "user gave a bad color".
 */
export function parseColorToAppleScriptRGB(input: string): string | null {
  const s = input.trim();
  if (!s) return null;

  // R,G,B
  const csv = s.split(',').map((p) => p.trim());
  if (csv.length === 3) {
    const [r, g, b] = csv.map(Number);
    if ([r, g, b].every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      return `{${r}, ${g}, ${b}}`;
    }
  }

  // #RRGGBB or RRGGBB
  let hex = s.toLowerCase();
  if (hex.startsWith('#')) hex = hex.slice(1);
  if (/^[0-9a-f]{6}$/.test(hex)) {
    const v = parseInt(hex, 16);
    return `{${(v >> 16) & 0xff}, ${(v >> 8) & 0xff}, ${v & 0xff}}`;
  }

  // named
  const named = NAMED_COLORS[s.toLowerCase()];
  if (named) return `{${named[0]}, ${named[1]}, ${named[2]}}`;

  return null;
}

/**
 * `--align` parser → AppleScript `paragraph align ...` enum.
 * Defaults silently to `paragraph align left` for unknown values; that
 * matches the Swift bridge behaviour and avoids breaking the script render.
 */
export function parseAlignToAppleScript(input: string): string {
  switch (input.trim().toLowerCase()) {
    case 'right':  return 'paragraph align right';
    case 'center': return 'paragraph align center';
    case 'left':
    default:       return 'paragraph align left';
  }
}

function renderTemplate(tpl: string, ctx: Record<string, string | boolean | number | null>): string {
  // {{#if name}}...{{/if}} — block emitted only when ctx[name] is truthy.
  // Greedy: not nestable. Sufficient for our skill templates.
  let out = tpl.replace(/\{\{#if\s+([\w-]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, name: string, body: string) => {
    return isTruthy(ctx[name]) ? body : '';
  });

  // {{name}} / {{name|filter}} substitution.
  out = out.replace(/\{\{\s*([\w-]+)(?:\s*\|\s*(\w+))?\s*\}\}/g, (_, name: string, filter?: string) => {
    const raw = ctx[name];
    if (raw === null || raw === undefined) return '';
    if (filter === 'json' || filter === 'string') {
      return '"' + String(raw).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }
    if (filter === 'posix') {
      const s = String(raw).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `POSIX file "${s}"`;
    }
    if (filter === 'bool') {
      return isTruthy(raw) ? 'true' : 'false';
    }
    if (filter === 'as_int') {
      const n = parseInt(String(raw), 10);
      return Number.isFinite(n) ? String(n) : '0';
    }
    if (filter === 'rgb') {
      // Empty / unparseable color → empty literal so the surrounding
      // {{#if name}} block degrades to "do nothing" instead of injecting
      // syntactically broken AppleScript.
      const lit = parseColorToAppleScriptRGB(String(raw));
      return lit ?? '';
    }
    if (filter === 'align') {
      return parseAlignToAppleScript(String(raw));
    }
    return String(raw);
  });

  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Dispatcher
// ──────────────────────────────────────────────────────────────────────

export function loadMacosBackend(skillDir: string): MacosBackendManifest | null {
  const f = join(skillDir, 'backends', 'macos', 'manifest.json');
  if (!existsSync(f)) return null;
  try {
    const obj = JSON.parse(readFileSync(f, 'utf-8'));
    if (!obj || typeof obj !== 'object' || !obj.actions) return null;
    return obj as MacosBackendManifest;
  } catch {
    return null;
  }
}

/**
 * Run an action on a macOS-backed skill. Returns the osascript outcome
 * verbatim (caller decides how to render).
 */
export function dispatchMacos(
  skillDir: string,
  action: string,
  call: SkillCall,
): DispatchResult {
  const backend = loadMacosBackend(skillDir);
  if (!backend) {
    return { ok: false, stdout: '', stderr: 'no macos backend installed for this skill', exitCode: 2 };
  }
  const actionSpec = backend.actions[action];
  if (!actionSpec) {
    return { ok: false, stdout: '', stderr: `unknown action: ${action}`, exitCode: 2 };
  }

  // Resolve named args.
  const ctx: Record<string, string | boolean | number | null> = {};
  for (const arg of actionSpec.args ?? []) {
    const v = resolveArg(arg, call);
    if (v === null) {
      return {
        ok: false, stdout: '',
        stderr: `missing required argument: ${arg.name} (from ${arg.from})`,
        exitCode: 2,
      };
    }
    ctx[arg.name] = v;
  }

  // Read + render the AppleScript template.
  const scriptPath = join(skillDir, 'backends', 'macos', actionSpec.script);
  if (!existsSync(scriptPath)) {
    return { ok: false, stdout: '', stderr: `script not found: ${scriptPath}`, exitCode: 2 };
  }
  let tpl = '';
  try { tpl = readFileSync(scriptPath, 'utf-8'); }
  catch (e) { return { ok: false, stdout: '', stderr: `read script failed: ${(e as Error).message}`, exitCode: 2 }; }
  const source = renderTemplate(tpl, ctx);
  if (process.env.YOME_DEBUG_SKILL === '1') {
    process.stderr.write(`── rendered ${actionSpec.script} ──\n${source}\n── end ──\n`);
  }

  // Two execution modes:
  //  1) openViaLaunchServices — for actions that open a file in an app
  //     and then need to wait until the app reports it loaded.
  //  2) plain osascript -e — everything else.
  if (actionSpec.openViaLaunchServices) {
    const filePath = String(ctx.path ?? ctx.positional ?? '');
    const appName = backend.appName ?? '';
    if (!filePath || !appName) {
      return { ok: false, stdout: '', stderr: 'openViaLaunchServices requires {{path}} arg and backend.appName', exitCode: 2 };
    }
    let pollSrc = '';
    if (actionSpec.pollScript) {
      const p = join(skillDir, 'backends', 'macos', actionSpec.pollScript);
      if (existsSync(p)) {
        pollSrc = renderTemplate(readFileSync(p, 'utf-8'), ctx);
      }
    }
    if (!pollSrc) pollSrc = source; // fallback: poll with the main script
    const r = openViaLaunchServices({
      filePath,
      appName,
      pollScript: pollSrc,
    });
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, exitCode: r.ok ? 0 : 1 };
  }

  return adapt(runOsascript(source, { timeoutMs: actionSpec.timeoutMs }));
}

function adapt(r: AppleScriptResult): DispatchResult {
  return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
}

// ──────────────────────────────────────────────────────────────────────
// Merged-batch dispatch
// ──────────────────────────────────────────────────────────────────────
//
// Take N {action, call} entries, render each .applescript template, and
// concatenate them as labelled try/catch blocks inside ONE osascript
// invocation. Saves the ~150-300ms cold-start cost per command and the
// IPC round-trips between the kernel and osascript.
//
// Constraints (caller is responsible):
//   - Mergeable actions don't use openViaLaunchServices (we'd need a
//     separate `open -a` call before the script). `open` actions are
//     skipped from merging and reported as "not mergeable".
//
// Output contract: one TSV-ish line per sub-command with status + result,
// followed by a summary; exit code 0 only if every step printed "ok".

export interface MergedBatchEntry {
  action: string;
  call: SkillCall;
}

export interface MergedBatchOptions {
  keepGoing: boolean;
}

export async function dispatchMacosBatchMerged(
  skillDir: string,
  entries: MergedBatchEntry[],
  opts: MergedBatchOptions,
): Promise<DispatchResult> {
  const backend = loadMacosBackend(skillDir);
  if (!backend) {
    return { ok: false, stdout: '', stderr: 'no macos backend installed for this skill', exitCode: 2 };
  }

  // Render every entry. We fail fast on render errors (missing arg / unknown
  // action) — those are user-facing bugs in the batch body, not runtime.
  const blocks: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const spec = backend.actions[e.action];
    if (!spec) {
      return {
        ok: false, stdout: '',
        stderr: `merge: unknown action '${e.action}' (line ${i + 1})`,
        exitCode: 2,
      };
    }
    if (spec.openViaLaunchServices) {
      return {
        ok: false, stdout: '',
        stderr:
          `merge: action '${e.action}' uses Launch Services and cannot be merged ` +
          `(line ${i + 1}). Re-run without --merge, or move it to its own batch.`,
        exitCode: 2,
      };
    }

    // Resolve args.
    const ctx: Record<string, string | boolean | number | null> = {};
    for (const arg of spec.args ?? []) {
      const v = resolveArg(arg, e.call);
      if (v === null) {
        return {
          ok: false, stdout: '',
          stderr: `merge: line ${i + 1} (${e.action}): missing required arg ${arg.name}`,
          exitCode: 2,
        };
      }
      ctx[arg.name] = v;
    }

    const scriptPath = join(skillDir, 'backends', 'macos', spec.script);
    if (!existsSync(scriptPath)) {
      return {
        ok: false, stdout: '',
        stderr: `merge: script not found for ${e.action}: ${scriptPath}`,
        exitCode: 2,
      };
    }
    const tpl = readFileSync(scriptPath, 'utf-8');
    const rendered = renderTemplate(tpl, ctx);

    // Wrap each rendered block in a try so a single failure doesn't kill
    // the whole script. We capture per-step result into a list so the
    // outer return can report the full status TSV.
    blocks.push(buildMergedBlock(i, e.action, rendered, opts.keepGoing));
  }

  const finalSource = `
-- yome-merged-batch (${entries.length} steps)
set results to {}
${blocks.join('\n')}
set AppleScript's text item delimiters to linefeed
return results as string
`;

  if (process.env.YOME_DEBUG_SKILL === '1') {
    process.stderr.write(`── merged batch (${entries.length} steps) ──\n${finalSource}\n── end ──\n`);
  }

  const r = runOsascript(finalSource);
  if (!r.ok && !r.stdout) {
    return { ok: false, stdout: '', stderr: r.stderr, exitCode: r.exitCode };
  }

  // Parse per-step lines from osascript stdout. Each line:
  //   "<status>\t<idx>\t<action>\t<msg>"
  const lines = r.stdout.split(/\n/).filter(Boolean);
  let okCount = 0, failCount = 0;
  const summary: string[] = [];
  for (const line of lines) {
    const parts = line.split('\t');
    const status = parts[0]!;
    const idx = parts[1] ?? '?';
    const action = parts[2] ?? '?';
    const msg = parts.slice(3).join('\t');
    if (status === 'OK') {
      okCount++;
      summary.push(`✓ [${idx}] ${action}${msg ? ': ' + msg : ''}`);
    } else {
      failCount++;
      summary.push(`✗ [${idx}] ${action}: ${msg}`);
    }
  }

  const tail =
    failCount === 0
      ? `\n— merged batch ok (${entries.length} commands, single osascript)`
      : `\n— merged batch: ${okCount}/${entries.length} ok, ${failCount} failed`;

  return {
    ok: failCount === 0,
    stdout: summary.join('\n') + tail,
    stderr: failCount === 0 ? '' : `${failCount} step(s) failed (see stdout for details)`,
    exitCode: failCount === 0 ? 0 : 1,
  };
}

/**
 * Wrap a rendered .applescript snippet so:
 *   - Its return value (if any) is captured into the outer `results` list
 *     prefixed with status + idx + action so the TS side can demux.
 *   - Errors are caught and recorded as "FAIL".
 *   - When keepGoing is false the first failure throws to abort the rest.
 *
 * The trick: the rendered snippets are top-level AppleScript with their
 * own `tell` blocks; we can't directly assign their `return` to a var.
 * We wrap them in `run script` of a freshly-built handler instead — that
 * lets us catch errors AND collect the result.
 */
function buildMergedBlock(idx: number, action: string, source: string, keepGoing: boolean): string {
  // Escape source for embedding inside an AppleScript string literal.
  const escaped = source.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const tag = `[${idx + 1}] ${action}`;
  const onError = keepGoing
    ? '' // swallow + continue
    : 'error errMsg'; // re-throw to abort the rest of the batch

  return `
try
    set stepSrc to "${escaped}"
    set stepResult to (run script stepSrc)
    if stepResult is missing value then
        set end of results to "OK\t${idx + 1}\t${action}\t"
    else
        set end of results to "OK\t${idx + 1}\t${action}\t" & (stepResult as string)
    end if
on error errMsg
    set end of results to "FAIL\t${idx + 1}\t${action}\t" & errMsg
    ${onError}
end try
`;
}
