// Daemon main loop.
//
// Responsibilities:
//   1. Read tasks.json on startup, register a node-cron job per
//      enabled cron task.
//   2. Watch tasks.json for changes (re-register on edit so that
//      `yome cron add/rm/...` takes effect without restarting daemon).
//   3. Handle SIGTERM/SIGINT cleanly (unregister jobs, remove pid file).
//
// File-trigger and calendar-trigger registration is left as TODO hooks
// (PR2 / PR4). The shape mirrors registerCronTask so adding a new
// trigger kind is "implement registerXxxTask + branch on kind here".

import { watch } from 'fs';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { listTasks } from './taskStore.js';
import { registerCronTask, unregisterCronTask, listActive as listActiveCron, resolveYomeBinPath } from './triggers/cron.js';
import { registerOnceTask, unregisterOnceTask, listActiveOnce } from './triggers/once.js';
import { registerFileTask, unregisterFileTask, listActiveFile } from './triggers/file.js';
import { registerCalendarTask, unregisterCalendarTask, listActiveCalendar } from './triggers/calendar.js';
import { ensureDirs, PID_FILE, TASKS_FILE } from './paths.js';
import type { TaskRecord } from './taskStore.js';

let started = false;
let watcher: ReturnType<typeof watch> | null = null;
let reloadDebounce: NodeJS.Timeout | null = null;

export function startDaemon(): void {
  if (started) return;
  started = true;
  ensureDirs();
  writePidFile();
  installSignalHandlers();
  reloadAllTasks();
  watchTasksFile();
  // eslint-disable-next-line no-console
  console.log(
    `[daemon] started (pid=${process.pid}); ` +
    `cron=${listActiveCron().length} once=${listActiveOnce().length} ` +
    `file=${listActiveFile().length} calendar=${listActiveCalendar().length}`,
  );
}

function reloadAllTasks(): void {
  const yomeBinPath = resolveYomeBinPath();
  const tasks = listTasks();
  const seen = new Set<string>();

  for (const t of tasks) {
    seen.add(t.id);
    if (!t.enabled) {
      unregisterAllForId(t.id);
      continue;
    }
    switch (t.trigger.kind) {
      case 'cron':     registerCronTask(t, { yomeBinPath }); break;
      case 'once':     registerOnceTask(t, { yomeBinPath }); break;
      case 'file':     registerFileTask(t, { yomeBinPath }); break;
      case 'calendar': registerCalendarTask(t, { yomeBinPath }); break;
    }
  }

  // Drop any active registrations that no longer exist in tasks.json.
  for (const activeId of [
    ...listActiveCron(),
    ...listActiveOnce().map((o) => o.taskId),
    ...listActiveFile(),
    ...listActiveCalendar(),
  ]) {
    if (!seen.has(activeId)) unregisterAllForId(activeId);
  }
}

/** Idempotently unregister an id from every trigger subsystem. */
function unregisterAllForId(id: string): void {
  unregisterCronTask(id);
  unregisterOnceTask(id);
  unregisterFileTask(id);
  unregisterCalendarTask(id);
}

function watchTasksFile(): void {
  // tasks.json is written via tmp+rename (atomic). fs.watch on the file
  // itself loses its handle after the first rename — the kernel inode
  // changes out from under it. Watching the PARENT directory and
  // filtering for tasks.json events survives renames forever and works
  // on macOS, Linux, and Windows.
  const dir = TASKS_FILE.replace(/\/[^/]+$/, '');
  const fileBase = TASKS_FILE.split('/').pop()!;
  try {
    watcher = watch(dir, (_eventType, filename) => {
      if (filename !== fileBase && filename !== `${fileBase}.tmp`) return;
      if (reloadDebounce) clearTimeout(reloadDebounce);
      reloadDebounce = setTimeout(() => {
        if (!existsSync(TASKS_FILE)) return; // mid-rename window
        // eslint-disable-next-line no-console
        console.log('[daemon] tasks.json changed, reloading…');
        try { reloadAllTasks(); } catch (e) { console.error('[daemon] reload failed:', e); }
      }, 250);
    });
  } catch (e) {
    console.error('[daemon] failed to watch tasks dir:', e);
  }
}

function writePidFile(): void {
  try { writeFileSync(PID_FILE, String(process.pid), 'utf-8'); } catch { /* noop */ }
}

function removePidFile(): void {
  try { unlinkSync(PID_FILE); } catch { /* noop */ }
}

function installSignalHandlers(): void {
  const shutdown = (sig: string) => {
    // eslint-disable-next-line no-console
    console.log(`[daemon] received ${sig}, shutting down…`);
    if (watcher) try { watcher.close(); } catch { /* noop */ }
    removePidFile();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/** Used by `yome daemon status` (called from a separate process — peeks pid file). */
export function readPidIfRunning(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const raw = readFileSync(PID_FILE, 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    if (!pid || Number.isNaN(pid)) return null;
    // process.kill(pid, 0) throws if the process doesn't exist.
    try { process.kill(pid, 0); return pid; }
    catch { return null; }
  } catch { return null; }
}

// Re-export for convenience in cli.ts.
export { TaskRecord };
