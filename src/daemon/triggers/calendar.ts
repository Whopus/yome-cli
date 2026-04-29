// cli/src/daemon/triggers/calendar.ts
//
// Calendar trigger — bridges between Yome tasks and the Swift
// `yome-calwatch` helper.
//
// Lifecycle (per task):
//   1. registerCalendarTask(task) writes a tiny JSON spec describing
//      the filter (events[], titleRegex, calendar, leadMs) into
//      ~/.yome/cron/calendar/<taskId>/spec.json.
//   2. We spawn `yome-calwatch --config <spec.json>` as a long-lived
//      child. Each task gets its own helper process so a single
//      crash/permission-revoke only takes down one trigger and the
//      filter args stay completely local to that helper.
//   3. The helper streams JSONL lines on stdout. We parse them and:
//        - "ready"      → emit a [daemon] log line, nothing else.
//        - "event"      → call runChildTask(...) with extraEnv carrying
//                         a [calendar event ...] context block to the
//                         Agent, and a triggerMeta entry for the audit log.
//        - "heartbeat"  → ignored (used to detect stalled helpers).
//        - "shutdown"   → ignored (clean exit).
//        - "error"      → emit, do NOT respawn if it's a permission error;
//                         else respawn with backoff.
//   4. unregisterCalendarTask(id) sends SIGTERM to the helper.
//
// Crash recovery:
//   If the helper exits with a non-zero code (and we did NOT request
//   shutdown), we respawn after a backoff that grows from 1s → 30s.
//   On clean exit (signal=SIGTERM after our request) we do nothing.
//
// State:
//   ~/.yome/cron/calendar/<taskId>/spec.json   filter spec
//   ~/.yome/cron/calendar/<taskId>/fired.json  helper-managed dedupe set

import { spawn, ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import type { TaskRecord, CalendarEventKind } from '../taskStore.js';
import { runChildTask } from './childRunner.js';
import { CRON_ROOT } from '../paths.js';

interface TriggerCtx {
  yomeBinPath: string;
}

interface ActiveCalTask {
  taskId: string;
  child: ChildProcess | null;
  buffer: string;             // partial-line accumulator for stdout
  shuttingDown: boolean;
  respawnTimer: NodeJS.Timeout | null;
  respawnDelayMs: number;     // grows on each crash
  permissionFailed: boolean;  // sticky: stop respawning if we hit no_permission
  /** Hash of the spec we currently spawned with — used by the
   *  idempotent re-register path to skip kill+respawn when nothing
   *  meaningful in the trigger config has changed. */
  specHash: string;
}

function hashSpec(s: object): string {
  // Small inputs; JSON.stringify with sorted keys is fine. We don't
  // need cryptographic strength — only "did anything change".
  const norm = JSON.stringify(s, Object.keys(s).sort());
  let h = 0;
  for (let i = 0; i < norm.length; i++) {
    h = (h * 31 + norm.charCodeAt(i)) | 0;
  }
  return String(h);
}

const active = new Map<string, ActiveCalTask>();

const SPEC_ROOT = join(CRON_ROOT, 'calendar');

function specPath(taskId: string): string {
  return join(SPEC_ROOT, taskId, 'spec.json');
}

function stateDir(taskId: string): string {
  return join(SPEC_ROOT, taskId);
}

function resolveCalwatchPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/daemon/triggers/calendar.js  → ../../../bin/yome-calwatch
  // src/daemon/triggers/calendar.ts   → ../../../bin/yome-calwatch
  return resolve(here, '..', '..', '..', 'bin', 'yome-calwatch');
}

export function registerCalendarTask(task: TaskRecord, ctx: TriggerCtx): void {
  if (task.trigger.kind !== 'calendar') return;

  const t = task.trigger;
  const dir = stateDir(task.id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const spec = {
    taskId: task.id,
    events: t.events as CalendarEventKind[],
    leadMs: t.leadMs ?? 0,
    titleRegex: t.titleRegex ?? '',
    calendar: t.calendar ?? '',
    stateDir: dir,
  };
  const newHash = hashSpec(spec);

  // Idempotent re-register: tasks.json gets rewritten on every
  // recordRun() → fs.watch fires → reloadAllTasks() walks every task.
  // Without this guard we'd kill the long-lived calwatch helper and
  // respawn it (losing the in-memory poll cycle, briefly orphaning
  // any in-flight EventKit query, and spamming the log) every time
  // ANY other task records a run. Skip when the spec is byte-identical.
  const existing = active.get(task.id);
  if (existing && existing.specHash === newHash && existing.child) {
    return;
  }

  // Spec changed (or no helper running) → tear down and respawn.
  unregisterCalendarTask(task.id);
  writeFileSync(specPath(task.id), JSON.stringify(spec, null, 2), 'utf-8');

  const at: ActiveCalTask = {
    taskId: task.id,
    child: null,
    buffer: '',
    shuttingDown: false,
    respawnTimer: null,
    respawnDelayMs: 1_000,
    permissionFailed: false,
    specHash: newHash,
  };
  active.set(task.id, at);
  spawnHelper(at, ctx);
}

export function unregisterCalendarTask(taskId: string): void {
  const at = active.get(taskId);
  if (!at) return;
  at.shuttingDown = true;
  if (at.respawnTimer) { clearTimeout(at.respawnTimer); at.respawnTimer = null; }
  if (at.child && !at.child.killed) {
    try { at.child.kill('SIGTERM'); } catch { /* noop */ }
  }
  active.delete(taskId);
}

export function listActiveCalendar(): string[] {
  return [...active.keys()];
}

function spawnHelper(at: ActiveCalTask, ctx: TriggerCtx): void {
  const bin = resolveCalwatchPath();
  if (!existsSync(bin)) {
    // eslint-disable-next-line no-console
    console.error(
      `[calendar:${at.taskId}] helper binary missing at ${bin}. ` +
      `Build with: cd cli && npm run build:native`,
    );
    return;
  }
  const child = spawn(bin, ['--config', specPath(at.taskId)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  at.child = child;
  // eslint-disable-next-line no-console
  console.log(`[calendar:${at.taskId}] helper started pid=${child.pid}`);

  child.stdout?.on('data', (chunk: Buffer) => {
    at.buffer += chunk.toString('utf-8');
    let nl: number;
    // Process complete lines; keep the trailing partial in the buffer.
    while ((nl = at.buffer.indexOf('\n')) >= 0) {
      const line = at.buffer.slice(0, nl).trim();
      at.buffer = at.buffer.slice(nl + 1);
      if (line) handleHelperLine(at, line, ctx);
    }
  });
  child.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(`[calendar:${at.taskId}] (helper stderr) ${d.toString('utf-8')}`);
  });
  child.on('exit', (code, signal) => {
    at.child = null;
    // eslint-disable-next-line no-console
    console.log(`[calendar:${at.taskId}] helper exited code=${code} signal=${signal}`);
    if (at.shuttingDown) return;
    if (at.permissionFailed) {
      console.error(`[calendar:${at.taskId}] permission failure is sticky; not respawning.`);
      return;
    }
    // Backoff respawn.
    const delay = at.respawnDelayMs;
    at.respawnDelayMs = Math.min(at.respawnDelayMs * 2, 30_000);
    at.respawnTimer = setTimeout(() => {
      if (!at.shuttingDown) spawnHelper(at, ctx);
    }, delay);
  });
}

function handleHelperLine(at: ActiveCalTask, line: string, ctx: TriggerCtx): void {
  let msg: any;
  try { msg = JSON.parse(line); }
  catch {
    process.stderr.write(`[calendar:${at.taskId}] non-JSON helper line: ${line}\n`);
    return;
  }
  switch (msg?.type) {
    case 'ready':
      // eslint-disable-next-line no-console
      console.log(
        `[calendar:${at.taskId}] ready (events=${(msg.events ?? []).join(',')} ` +
        `titleRegex=${JSON.stringify(msg.titleRegex ?? '')} ` +
        `calendar=${JSON.stringify(msg.calendar ?? '')})`,
      );
      // First successful ready resets backoff so a transient EventKit
      // hiccup doesn't leave us stuck at 30s respawns.
      at.respawnDelayMs = 1_000;
      return;

    case 'event':
      handleEventFire(at, msg, ctx);
      return;

    case 'heartbeat':
      return;

    case 'shutdown':
      return;

    case 'error': {
      const code = String(msg.code ?? '');
      // eslint-disable-next-line no-console
      console.error(`[calendar:${at.taskId}] helper error: ${msg.message} (fix: ${msg.fix ?? '-'})`);
      if (code === 'no_permission') at.permissionFailed = true;
      return;
    }

    default:
      // eslint-disable-next-line no-console
      console.warn(`[calendar:${at.taskId}] unknown helper message type: ${msg?.type}`);
  }
}

function handleEventFire(
  at: ActiveCalTask,
  msg: { kind: string; eventId: string; title: string; calendar: string; startMs: number; endMs: number; location?: string; notes?: string },
  ctx: TriggerCtx,
): void {
  // Look up the live task record so we have prompt + permissions.
  // Lazy-import to avoid circular module deps with scheduler.
  import('../taskStore.js').then((m) => {
    const task = m.getTask(at.taskId);
    if (!task || !task.enabled) return;

    const startIso = new Date(msg.startMs).toISOString();
    const endIso = msg.endMs ? new Date(msg.endMs).toISOString() : '';
    const ctxLines = [
      `[calendar trigger fired]`,
      `kind:     ${msg.kind}`,
      `eventId:  ${msg.eventId}`,
      `title:    ${msg.title}`,
      `calendar: ${msg.calendar}`,
      `start:    ${startIso}`,
      ...(endIso ? [`end:      ${endIso}`] : []),
      ...(msg.location ? [`location: ${msg.location}`] : []),
      ...(msg.notes ? [`notes:\n${msg.notes}`] : []),
    ];
    const extraContext = ctxLines.join('\n');

    runChildTask({
      taskId: at.taskId,
      yomeBinPath: ctx.yomeBinPath,
      task,
      triggerMeta: {
        triggerKind: 'calendar',
        calendarKind: msg.kind,
        eventId: msg.eventId,
        title: msg.title,
        startMs: msg.startMs,
      },
      extraEnv: { YOME_TASK_EXTRA_CONTEXT: extraContext },
    });
  });
}
