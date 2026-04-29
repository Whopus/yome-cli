// `yome cron <subcommand>` — task management UI on top of taskStore.
//
// add     create a new task
// list    list tasks
// rm      delete a task
// enable / disable
// run     manually fire a task right now (out-of-process, like the scheduler does)
// logs    show audit logs for a task
//
// All of these are pure CLI side-effects. The actual scheduling lives in
// the daemon process; tasks.json is the shared state and the daemon
// watches it for changes (see scheduler.ts).

import cron from 'node-cron';
import { addTask, listTasks, removeTask, getTask, setEnabled } from './taskStore.js';
import { humanToCron } from './humanCron.js';
import { humanToOnceMs } from './humanOnce.js';
import { fireTask, resolveYomeBinPath } from './triggers/cron.js';
import { listRunsForTask, readRunLog } from './log.js';
import { readPidIfRunning } from './scheduler.js';
import { execSync } from 'child_process';
import type { TriggerSpec, CalendarEventKind } from './taskStore.js';
import { checkCalendarAccess } from './calendarPermission.js';

export interface CronCliFlags {
  at?: string;        // crontab-format schedule
  human?: string;     // friendly schedule ("9:00", "every 5 min")
  once?: string;      // one-shot fire time ("in 5 min", "tomorrow 9:00", ISO)
  on?: string;        // event trigger: "file:change", "calendar:event-start"
  path?: string;      // glob for --on file:*
  within?: string;    // calendar lead time, e.g. "10m" / "30s" / "1h"
  titleRegex?: string;// calendar title regex filter
  calendar?: string;  // calendar display-name filter (case-insensitive contains)
  tz?: string;
  cwd?: string;
  allow?: string | string[];     // comma-separated rules (or repeat the flag)
  deny?: string | string[];
  maxMs?: string;     // wall-time cap, ms
  env?: string | string[];  // KEY=VAL, repeatable, e.g. --env YOME_WEB_HEADLESS=0
  follow?: boolean;
  json?: boolean;
}

export async function runCronSubcommand(args: string[], flags: CronCliFlags): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case 'add':         return doAdd(args.slice(1), flags);
    case 'list':
    case 'ls':          return doList(flags);
    case 'rm':
    case 'remove':      return doRm(args.slice(1));
    case 'enable':      return doToggle(args.slice(1), true);
    case 'disable':     return doToggle(args.slice(1), false);
    case 'run':         return doRun(args.slice(1));
    case 'logs':        return doLogs(args.slice(1), flags);
    case undefined:
    case 'help':
    case '--help':      printHelp(); return 0;
    default:
      console.error(`Unknown subcommand: yome cron ${sub}`);
      printHelp();
      return 2;
  }
}

function printHelp(): void {
  console.log(`Usage: yome cron <subcommand>

  add "<prompt>"   Add a task. Pick exactly one trigger:
                     --at "<crontab>"        cron schedule, e.g. "0 18 * * *"
                     --human "<phrase>"      friendly: "9:00", "every 5 min", "mon 9:00"
                     --once "<time>"         one-shot: "in 5 minutes",
                                              "tomorrow 9:00", "2026-04-30 18:00", ISO 8601
                     --on file:<event> --path "<glob>"
                                              fire on file events. <event> ∈
                                                change (add+change, default),
                                                any (add+change+unlink),
                                                add, unlink
                                              Glob: "~/Desktop/test/**/*.xlsx"
                     --on calendar:<event>   fire on macOS Calendar events. <event> ∈
                                                event-start (default), event-end, event-added
                                              Filters (calendar only):
                                                --within "10m"           lead time before start
                                                --title-regex "^Standup" case-insensitive title match
                                                --calendar "Work"        calendar display name (substring)
                   Optional:
                     --tz <iana>             timezone (default: system local; cron only)
                     --cwd <dir>             working dir for the task
                     --allow <rules>         comma-separated allowlist, e.g. "Read,Write,Yome(@yome/fs:*)"
                     --deny  <rules>         comma-separated denylist
                     --max-ms <ms>           wall-time cap (default 300000)
  list / ls         List tasks
  rm <id>           Remove a task
  enable <id>       Re-enable a paused task
  disable <id>      Pause a task without deleting it
  run <id>          Fire a task immediately (out-of-process)
  logs <id> [-f]    Show audit logs for a task
                     -f / --follow            follow the latest run

Tip: edits to tasks.json take effect immediately — the daemon watches
the file. You don't need to restart the daemon after add/rm/enable.`);
}

function doAdd(args: string[], flags: CronCliFlags): number {
  const prompt = args[0];
  if (!prompt) {
    console.error('Usage: yome cron add "<prompt>" <--at|--human|--once|--on ...>');
    return 2;
  }

  // Exactly one trigger type must be specified.
  const triggerSpecified = [flags.at, flags.human, flags.once, flags.on].filter(Boolean).length;
  if (triggerSpecified === 0) {
    console.error('Must specify a trigger: --at, --human, --once, or --on');
    return 2;
  }
  if (triggerSpecified > 1) {
    console.error('Specify exactly ONE trigger (--at / --human / --once / --on)');
    return 2;
  }

  let trigger: TriggerSpec;
  let summary: string;

  try {
    if (flags.at || flags.human) {
      let schedule: string;
      if (flags.at) {
        if (!cron.validate(flags.at)) throw new Error(`Invalid crontab: '${flags.at}'`);
        schedule = flags.at;
      } else {
        schedule = humanToCron(flags.human!);
      }
      trigger = { kind: 'cron', schedule, ...(flags.tz ? { tz: flags.tz } : {}) };
      summary = `cron "${schedule}"${flags.tz ? ` tz=${flags.tz}` : ''}`;
    } else if (flags.once) {
      const atMs = humanToOnceMs(flags.once);
      trigger = { kind: 'once', atMs };
      summary = `once @ ${new Date(atMs).toISOString()}`;
    } else if (flags.on) {
      // file:change      → add+change (any mutation that creates/updates content)
      // file:any         → add+change+unlink
      // file:add         → just creates
      // file:unlink      → just deletions
      // calendar:event-start | event-end | event-added (each via Swift helper)
      const [domain, event] = flags.on.split(':');
      if (domain === 'file') {
        if (!flags.path) throw new Error('--on file:* requires --path "<glob>"');
        const events = mapFileEvent(event ?? 'change');
        trigger = { kind: 'file', path: flags.path, events };
        summary = `file ${event ?? 'change'} on ${flags.path}`;
      } else if (domain === 'calendar') {
        const ev = (event ?? 'event-start') as CalendarEventKind;
        if (ev !== 'event-start' && ev !== 'event-end' && ev !== 'event-added') {
          throw new Error(`unknown calendar event: ${ev} (use event-start | event-end | event-added)`);
        }
        // Pre-flight permission probe so the user gets immediate feedback
        // instead of "task added but never fires". Mirrors option C in the
        // PR4 plan (helper also re-checks at watcher startup).
        const access = checkCalendarAccess();
        if (!access.ok) {
          let msg = `cannot add calendar trigger: ${access.message}`;
          if (access.fix) msg += `\n  → ${access.fix}`;
          throw new Error(msg);
        }
        const leadMs = flags.within ? parseDurationMs(flags.within) : 0;
        trigger = {
          kind: 'calendar',
          events: [ev],
          ...(leadMs ? { leadMs } : {}),
          ...(flags.titleRegex ? { titleRegex: flags.titleRegex } : {}),
          ...(flags.calendar ? { calendar: flags.calendar } : {}),
        };
        const filterDesc = [
          flags.titleRegex ? `title=/${flags.titleRegex}/i` : '',
          flags.calendar ? `cal="${flags.calendar}"` : '',
          leadMs ? `lead=${flags.within}` : '',
        ].filter(Boolean).join(' ');
        summary = `calendar ${ev}${filterDesc ? ` ${filterDesc}` : ''}`;
      } else {
        throw new Error(`unknown --on event: ${flags.on}`);
      }
    } else {
      throw new Error('unreachable');
    }
  } catch (e: any) {
    console.error(`✗ ${e?.message ?? e}`);
    return 2;
  }

  const t = addTask({
    trigger,
    prompt,
    cwd: flags.cwd,
    autoAllow: parseRuleList(flags.allow),
    autoDeny: parseRuleList(flags.deny),
    maxDurationMs: flags.maxMs ? Number.parseInt(flags.maxMs, 10) : undefined,
    env: parseEnvList(flags.env),
  });
  console.log(`✓ added ${t.id}`);
  console.log(`  trigger:    ${summary}`);
  console.log(`  prompt:     ${prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt}`);
  if (t.autoAllow?.length) console.log(`  autoAllow:  ${t.autoAllow.join(', ')}`);
  if (t.autoDeny?.length) console.log(`  autoDeny:   ${t.autoDeny.join(', ')}`);
  if (!readPidIfRunning()) {
    console.log('');
    console.log('⚠️  Daemon is not running. Start it with: yome daemon start');
  }
  return 0;
}

function parseRuleList(s?: string | string[]): string[] | undefined {
  if (!s) return undefined;
  // meow with isMultiple gives us an array; the manual case (single
  // --allow "a,b,c") gives us a string. Normalise both into a flat
  // array of comma-trimmed rule names.
  const parts = Array.isArray(s) ? s : [s];
  const out = parts.flatMap((p) => p.split(',').map((x) => x.trim()).filter(Boolean));
  return out.length === 0 ? undefined : out;
}

/**
 * Parse repeated --env KEY=VAL flags (or a single comma-separated string)
 * into a flat { KEY: VAL } record. Quoted values aren't unescaped — pass
 * them via shell quoting at the call site.
 */
function parseEnvList(s?: string | string[]): Record<string, string> | undefined {
  if (!s) return undefined;
  const parts = Array.isArray(s) ? s : [s];
  const out: Record<string, string> = {};
  for (const p of parts) {
    for (const kv of p.split(',')) {
      const eq = kv.indexOf('=');
      if (eq <= 0) continue;
      const k = kv.slice(0, eq).trim();
      const v = kv.slice(eq + 1).trim();
      if (k) out[k] = v;
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Parse a friendly duration string into milliseconds.
 *   "30s" → 30000   "10m" → 600000   "2h" → 7200000   "500ms" → 500
 *   bare number → milliseconds.
 */
function parseDurationMs(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(s.trim());
  if (!m) throw new Error(`invalid duration: ${JSON.stringify(s)} (use e.g. "30s", "10m", "2h")`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'ms').toLowerCase();
  switch (unit) {
    case 'ms': return Math.round(n);
    case 's':  return Math.round(n * 1000);
    case 'm':  return Math.round(n * 60_000);
    case 'h':  return Math.round(n * 3_600_000);
    default:   return Math.round(n);
  }
}

/**
 * Map a user-friendly file event token into chokidar event names.
 *
 * Most users typing `--on file:change` mean "any time these files are
 * created, edited, or deleted" rather than chokidar's strict "change =
 * existing file content modified, distinct from add/unlink". We pick a
 * sensible default and let power users be explicit.
 */
function mapFileEvent(token: string): ('add' | 'change' | 'unlink')[] {
  switch (token.toLowerCase()) {
    case 'change':            return ['add', 'change'];
    case 'any':
    case '*':                 return ['add', 'change', 'unlink'];
    case 'add':               return ['add'];
    case 'unlink':
    case 'delete':            return ['unlink'];
    default:
      throw new Error(`unknown file event: '${token}' (try change | add | unlink | any)`);
  }
}

function doList(flags: CronCliFlags): number {
  const tasks = listTasks();
  if (flags.json) {
    process.stdout.write(JSON.stringify(tasks, null, 2) + '\n');
    return 0;
  }
  if (tasks.length === 0) {
    console.log('(no tasks defined — use `yome cron add ...`)');
    return 0;
  }
  const idW = Math.max(2, ...tasks.map((t) => t.id.length));
  const schedW = Math.max(8, ...tasks.map((t) => trigSummary(t.trigger).length));
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  console.log(`  ${pad('ID', idW)}  ${pad('SCHEDULE', schedW)}  STATE  LAST-RUN              PROMPT`);
  for (const t of tasks) {
    const state = t.enabled ? 'on ' : 'off';
    const last = t.lastRun
      ? new Date(t.lastRun.ts).toISOString().replace('T', ' ').slice(0, 19) + (t.lastRun.ok ? ' ok' : ' err')
      : '—';
    const prompt = t.prompt.length > 60 ? t.prompt.slice(0, 60) + '…' : t.prompt;
    console.log(`  ${pad(t.id, idW)}  ${pad(trigSummary(t.trigger), schedW)}  ${state}    ${pad(last, 22)} ${prompt}`);
  }
  if (!readPidIfRunning() && tasks.some((t) => t.enabled)) {
    console.log('');
    console.log('⚠️  Daemon is not running — enabled tasks will not fire. Start with: yome daemon start');
  }
  return 0;
}

function trigSummary(trig: any): string {
  if (trig?.kind === 'cron') return trig.schedule;
  if (trig?.kind === 'once') return `once @ ${new Date(trig.atMs).toISOString().slice(0, 16)}`;
  if (trig?.kind === 'file') return `file:${trig.path}`;
  if (trig?.kind === 'calendar') {
    const ev = (trig.events ?? ['event-start']).join(',');
    const bits: string[] = [`cal:${ev}`];
    if (trig.leadMs) bits.push(`-${Math.round(trig.leadMs / 1000)}s`);
    if (trig.titleRegex) bits.push(`/${trig.titleRegex}/`);
    if (trig.calendar) bits.push(`@${trig.calendar}`);
    return bits.join(' ');
  }
  return '?';
}

function doRm(args: string[]): number {
  const id = args[0];
  if (!id) { console.error('Usage: yome cron rm <id>'); return 2; }
  if (!removeTask(id)) { console.error(`✗ no such task: ${id}`); return 1; }
  console.log(`✓ removed ${id}`);
  return 0;
}

function doToggle(args: string[], enabled: boolean): number {
  const id = args[0];
  if (!id) { console.error(`Usage: yome cron ${enabled ? 'enable' : 'disable'} <id>`); return 2; }
  if (!setEnabled(id, enabled)) { console.error(`✗ no such task: ${id}`); return 1; }
  console.log(`✓ ${enabled ? 'enabled' : 'disabled'} ${id}`);
  return 0;
}

function doRun(args: string[]): number {
  const id = args[0];
  if (!id) { console.error('Usage: yome cron run <id>'); return 2; }
  const t = getTask(id);
  if (!t) { console.error(`✗ no such task: ${id}`); return 1; }
  // Spawn out-of-process via the same path the scheduler uses, so behaviour
  // (stdout capture, kill timer, jsonl logging) matches a scheduled fire.
  console.log(`→ firing ${id} now (out-of-process)…`);
  fireTask(id, resolveYomeBinPath(), t);
  console.log(`✓ task spawned. Watch logs with: yome cron logs ${id} -f`);
  return 0;
}

function doLogs(args: string[], flags: CronCliFlags): number {
  const id = args[0];
  if (!id) { console.error('Usage: yome cron logs <id> [-f]'); return 2; }
  const runs = listRunsForTask(id);
  if (runs.length === 0) {
    console.log(`(no runs recorded for ${id} yet)`);
    return 0;
  }
  const latest = runs[0]!;
  if (flags.follow) {
    try {
      execSync(`tail -F "${latest.file}"`, { stdio: 'inherit' });
    } catch { /* user terminated tail */ }
    return 0;
  }
  console.log(`── latest run: ${new Date(latest.runTs).toISOString()} (${latest.file}) ──`);
  for (const e of readRunLog(latest.file)) {
    const t = new Date(e.ts).toISOString().slice(11, 19);
    if (e.type === 'tool_use') {
      console.log(`[${t}] tool ${e.name}  ${JSON.stringify(e.input).slice(0, 120)}`);
    } else if (e.type === 'tool_result') {
      const r = String(e.result ?? '').replace(/\n/g, ' ').slice(0, 120);
      console.log(`[${t}] └─ ${r}`);
    } else if (e.type === 'run_start' || e.type === 'run_end') {
      console.log(`[${t}] ${e.type} ${JSON.stringify({ ok: e.ok, durationMs: e.durationMs, error: e.error }).slice(0, 200)}`);
    } else {
      console.log(`[${t}] ${e.type} ${JSON.stringify(e).slice(0, 200)}`);
    }
  }
  if (runs.length > 1) {
    console.log('');
    console.log(`(${runs.length - 1} earlier run(s) in ${latest.file.replace(/\/[^/]+$/, '')})`);
  }
  return 0;
}
