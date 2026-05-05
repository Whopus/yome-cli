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

// Named colors that map to RGB triples. Superset of the CSS named-color list,
// extended with a few CN-friendly aliases. Single source of truth on the CLI
// side; the Swift bridges (PowerPointBridge / WordBridge / NumbersBridge /
// PagesBridge / KeynoteBridge) intentionally mirror this table — when adding
// or renaming an entry here, update those Swift maps in lockstep.
export const NAMED_COLORS: Record<string, [number, number, number]> = {
  // grayscale
  black:        [0, 0, 0],
  white:        [255, 255, 255],
  gray:         [128, 128, 128],
  grey:         [128, 128, 128],
  silver:       [192, 192, 192],
  lightgray:    [211, 211, 211],
  lightgrey:    [211, 211, 211],
  darkgray:     [169, 169, 169],
  darkgrey:     [169, 169, 169],

  // primaries / secondaries
  red:          [255, 0, 0],
  green:        [0, 128, 0],
  lime:         [0, 255, 0],
  blue:         [0, 0, 255],
  yellow:       [255, 255, 0],
  cyan:         [0, 255, 255],
  aqua:         [0, 255, 255],
  magenta:      [255, 0, 255],
  fuchsia:      [255, 0, 255],

  // common css
  navy:         [0, 51, 102],
  darkblue:     [0, 51, 102],
  royalblue:    [65, 105, 225],
  midnightblue: [25, 25, 112],
  steelblue:    [70, 130, 180],
  skyblue:      [135, 206, 235],
  lightblue:    [173, 216, 230],
  teal:         [0, 128, 128],
  darkgreen:    [0, 100, 0],
  lightgreen:   [144, 238, 144],
  olive:        [128, 128, 0],
  orange:       [255, 165, 0],
  darkorange:   [255, 140, 0],
  gold:         [255, 215, 0],
  brown:        [165, 42, 42],
  maroon:       [128, 0, 0],
  crimson:      [220, 20, 60],
  pink:         [255, 192, 203],
  hotpink:      [255, 105, 180],
  purple:       [128, 0, 128],
  violet:       [238, 130, 238],
  indigo:       [75, 0, 130],
  beige:        [245, 245, 220],
  ivory:        [255, 255, 240],
  khaki:        [240, 230, 140],
  tan:          [210, 180, 140],

  // CN aliases (commonly used in prompts / docs)
  '黑':         [0, 0, 0],
  '黑色':       [0, 0, 0],
  '白':         [255, 255, 255],
  '白色':       [255, 255, 255],
  '红':         [255, 0, 0],
  '红色':       [255, 0, 0],
  '蓝':         [0, 0, 255],
  '蓝色':       [0, 0, 255],
  '深蓝':       [0, 51, 102],
  '海军蓝':     [0, 51, 102],
  '绿':         [0, 128, 0],
  '绿色':       [0, 128, 0],
  '深绿':       [0, 100, 0],
  '黄':         [255, 255, 0],
  '黄色':       [255, 255, 0],
  '橙':         [255, 165, 0],
  '橙色':       [255, 165, 0],
  '紫':         [128, 0, 128],
  '紫色':       [128, 0, 128],
  '粉':         [255, 192, 203],
  '粉色':       [255, 192, 203],
  '灰':         [128, 128, 128],
  '灰色':       [128, 128, 128],
  '浅灰':       [211, 211, 211],
  '深灰':       [169, 169, 169],
  '青':         [0, 255, 255],
  '青色':       [0, 255, 255],
};

export interface ColorParseFailure {
  input: string;
  reason: string; // human-readable, never user-controlled
}

/**
 * Parse a color spec into an AppleScript RGB literal `{r, g, b}`.
 *
 * Accepted forms (case- and whitespace-insensitive):
 *   • `#RRGGBB` or bare `RRGGBB`
 *   • `R,G,B`  with each channel in 0..255
 *   • Named color from NAMED_COLORS (CSS-ish + CN aliases)
 *
 * Returns `{ ok: true, literal }` on success, or `{ ok: false, error }` with
 * a precise reason on failure. Callers MUST surface the error rather than
 * silently emitting an empty literal — silent fallbacks were the root cause
 * of the historical "bg disappeared from the format result" class of bugs.
 */
export type ColorParseResult =
  | { ok: true; literal: string; rgb: [number, number, number] }
  | { ok: false; error: ColorParseFailure };

export function parseColor(input: string): ColorParseResult {
  const raw = String(input ?? '');
  const s = raw.trim();
  if (!s) return { ok: false, error: { input: raw, reason: 'color is empty' } };

  // R,G,B
  if (s.includes(',')) {
    const csv = s.split(',').map((p) => p.trim());
    if (csv.length === 3) {
      const [r, g, b] = csv.map(Number);
      if ([r, g, b].every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        return { ok: true, literal: `{${r}, ${g}, ${b}}`, rgb: [r!, g!, b!] };
      }
      return {
        ok: false,
        error: {
          input: raw,
          reason: 'looks like R,G,B but channels must be integers in 0..255',
        },
      };
    }
  }

  // #RRGGBB or RRGGBB (only when the string is hex-shaped — never accept a
  // bare named color as hex by accident, e.g. `cab` is not a color, `bed`
  // would otherwise parse as #00bed0).
  let hex = s.toLowerCase();
  if (hex.startsWith('#')) hex = hex.slice(1);
  if (/^[0-9a-f]{6}$/.test(hex) && (s.startsWith('#') || /^[0-9a-f]{6}$/.test(s.toLowerCase()))) {
    const v = parseInt(hex, 16);
    const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
    return { ok: true, literal: `{${r}, ${g}, ${b}}`, rgb: [r, g, b] };
  }

  // named
  const key = s.toLowerCase();
  const named = NAMED_COLORS[key] ?? NAMED_COLORS[s]; // CN keys aren't lowercased
  if (named) {
    return { ok: true, literal: `{${named[0]}, ${named[1]}, ${named[2]}}`, rgb: named };
  }

  return {
    ok: false,
    error: {
      input: raw,
      reason:
        'unrecognised color (use #RRGGBB, R,G,B, or a named color like ' +
        'red/blue/navy/teal/gray; full list in NAMED_COLORS)',
    },
  };
}

/**
 * Back-compat wrapper that returns the literal or null. New code should use
 * `parseColor()` so the failure reason can be surfaced to the user.
 */
export function parseColorToAppleScriptRGB(input: string): string | null {
  const r = parseColor(input);
  return r.ok ? r.literal : null;
}

/**
 * `--type` alias → AppleScript `MsoAutoShapeType` enum literal. Unknown
 * aliases degrade to `autoshape rectangle` so the template never emits
 * broken AppleScript.
 */
export function parseAutoshapeToAppleScript(input: string): string {
  switch (input.trim().toLowerCase()) {
    case 'rectangle':     return 'autoshape rectangle';
    case 'oval':          return 'autoshape oval';
    case 'roundedrect':
    case 'roundedrectangle': return 'autoshape rounded rectangle';
    case 'triangle':      return 'autoshape isosceles triangle';
    case 'rightarrow':    return 'autoshape right arrow';
    case 'star5':
    case 'star':          return 'autoshape five point star';
    case 'pentagon':      return 'autoshape regular pentagon';
    case 'diamond':       return 'autoshape diamond';
    case 'hexagon':       return 'autoshape hexagon';
    case 'cloud':         return 'autoshape cloud';
    case 'lightningbolt': return 'autoshape lightning bolt';
    case 'heart':         return 'autoshape heart';
    default:              return 'autoshape rectangle';
  }
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

export interface RenderError {
  arg: string;        // template variable name, e.g. "bg"
  filter?: string;    // filter name, e.g. "rgb"
  reason: string;     // human-readable
}

export interface RenderResult {
  source: string;
  errors: RenderError[];
}

/**
 * Render an AppleScript template.
 *
 * Two failure modes exist:
 *  - "soft": the filter accepts any input and just renders something
 *    (`json`, `posix`, `bool`, `as_int`, `align`, `autoshape`). These never
 *    populate `errors`.
 *  - "hard": the filter validates input and can reject it (`rgb`). When
 *    rejected we emit a syntactically VALID placeholder (`missing value`)
 *    so the rendered AppleScript still parses, AND we record the error
 *    in `errors[]`. The dispatcher checks `errors` BEFORE running osascript
 *    and refuses to run with a structured message — no more silent failure
 *    where `bg=深蓝` quietly emitted broken AppleScript.
 *
 * `{{name}}` / `{{name|filter}}` is the substitution syntax.
 * `{{#if name}}…{{/if}}` is the conditional block (greedy, not nestable).
 * Substitution happens AFTER conditionals, so a `{{#if bg}}…{{bg|rgb}}…{{/if}}`
 * block whose `bg` was stripped never reaches the filter.
 */
export function renderTemplate(
  tpl: string,
  ctx: Record<string, string | boolean | number | null>,
): RenderResult {
  const errors: RenderError[] = [];

  // {{#if name}}...{{/if}} — block emitted only when ctx[name] is truthy.
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
      // An empty/false value means "user didn't pass this optional flag" —
      // emit an empty literal so templates that do `set x to {{c|rgb}}`
      // followed by `if x is not "" then …` keep working. We only validate
      // when the user ACTUALLY provided a value.
      const s = String(raw);
      if (s === '' || raw === false) return '""';
      const r = parseColor(s);
      if (r.ok) return r.literal;
      errors.push({ arg: name, filter: 'rgb', reason: `--${name}=${r.error.input}: ${r.error.reason}` });
      // Emit a syntactically VALID AppleScript token so the surrounding
      // script still parses — the dispatcher sees `errors[]` populated and
      // refuses to run osascript anyway, but we want render to be total.
      return 'missing value';
    }
    if (filter === 'align') {
      return parseAlignToAppleScript(String(raw));
    }
    if (filter === 'autoshape') {
      return parseAutoshapeToAppleScript(String(raw));
    }
    return String(raw);
  });

  return { source: out, errors };
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
  const rendered = renderTemplate(tpl, ctx);
  if (rendered.errors.length > 0) {
    return {
      ok: false,
      stdout: '',
      stderr: rendered.errors.map((e) => `[${action}] bad argument: ${e.reason}`).join('\n'),
      exitCode: 2,
    };
  }
  const source = rendered.source;
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
        const r = renderTemplate(readFileSync(p, 'utf-8'), ctx);
        if (r.errors.length > 0) {
          return {
            ok: false, stdout: '',
            stderr: r.errors.map((e) => `[${action}.poll] bad argument: ${e.reason}`).join('\n'),
            exitCode: 2,
          };
        }
        pollSrc = r.source;
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
    if (rendered.errors.length > 0) {
      // Fail the whole batch BEFORE running osascript: a render error in
      // one step (e.g. a bad color name) used to silently emit broken
      // AppleScript and produce a confusing "OK" line. Surface it loudly.
      return {
        ok: false, stdout: '',
        stderr:
          `merge: line ${i + 1} (${e.action}): ` +
          rendered.errors.map((er) => er.reason).join('; '),
        exitCode: 2,
      };
    }

    // Wrap each rendered block in a try so a single failure doesn't kill
    // the whole script. We capture per-step result into a list so the
    // outer return can report the full status TSV.
    blocks.push(buildMergedBlock(i, e.action, rendered.source, opts.keepGoing));
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
  //
  // The `<msg>` for partial-success-aware actions (xl/ppt/doc fmt, cf, …)
  // follows the convention "<okList>|<failList>" — when failList is non-empty
  // the step is reported as a partial failure even though osascript itself
  // returned without throwing. Without this demux a `fmt` whose `bg` silently
  // failed would still be counted as ✓ in the batch summary.
  const lines = r.stdout.split(/\n/).filter(Boolean);
  let okCount = 0, partialCount = 0, failCount = 0;
  const summary: string[] = [];
  for (const line of lines) {
    const parts = line.split('\t');
    const status = parts[0]!;
    const idx = parts[1] ?? '?';
    const action = parts[2] ?? '?';
    const msg = parts.slice(3).join('\t');
    if (status === 'OK') {
      const partial = parsePartialOkFail(msg);
      if (partial && partial.fail) {
        partialCount++;
        const okPart = partial.ok ? `ok=[${partial.ok}] ` : '';
        summary.push(`⚠ [${idx}] ${action}: ${okPart}failed=[${partial.fail}]`);
      } else {
        okCount++;
        summary.push(`✓ [${idx}] ${action}${msg ? ': ' + msg : ''}`);
      }
    } else {
      failCount++;
      summary.push(`✗ [${idx}] ${action}: ${msg}`);
    }
  }

  const totalFail = failCount + partialCount;
  const tail =
    totalFail === 0
      ? `\n— merged batch ok (${entries.length} commands, single osascript)`
      : `\n— merged batch: ${okCount}/${entries.length} ok` +
        (partialCount ? `, ${partialCount} partial` : '') +
        (failCount ? `, ${failCount} failed` : '');

  const stderrParts: string[] = [];
  if (failCount) stderrParts.push(`${failCount} step(s) failed`);
  if (partialCount) stderrParts.push(`${partialCount} step(s) partially failed`);
  return {
    ok: totalFail === 0,
    stdout: summary.join('\n') + tail,
    stderr: stderrParts.length ? stderrParts.join('; ') + ' (see stdout for details)' : '',
    exitCode: totalFail === 0 ? 0 : 1,
  };
}

/**
 * Demux the "<okList>|<failList>" convention used by partial-success-aware
 * AppleScript templates (xl/ppt/doc `fmt`, `cf`, …). Returns null when the
 * payload doesn't look like that shape — callers should treat null as
 * "ordinary opaque message, leave it alone".
 */
export function parsePartialOkFail(msg: string): { ok: string; fail: string } | null {
  // Conservative: only one '|' separator at the top level. We don't try to
  // be clever about escaping because the templates that emit this shape only
  // produce comma-separated identifiers + AppleScript error messages on the
  // right (which never contain `|` in practice).
  const i = msg.indexOf('|');
  if (i < 0) return null;
  return { ok: msg.slice(0, i), fail: msg.slice(i + 1) };
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
