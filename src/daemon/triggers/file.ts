// File-system trigger backed by chokidar.
//
// Storage shape:
//   { kind: 'file', path: '<glob>', events?: ['change'|'add'|'unlink'][] }
//
// Path can be a single file, a directory (recursive), or a glob
// ('~/Desktop/test/**/*.xlsx'). chokidar handles tilde-expansion poorly,
// so we expand it ourselves before handing the pattern over.
//
// Debouncing: chokidar fires multiple events for a single save on some
// editors (e.g. Excel writes a temp file then renames). We coalesce
// per-task into a 750ms window so the agent gets called once per logical
// change burst, not once per low-level fs syscall.

import chokidar from 'chokidar';
import { homedir } from 'os';
import type { TaskRecord } from '../taskStore.js';
import { runChildTask } from './childRunner.js';

type FileEvent = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

interface ActiveWatch {
  taskId: string;
  watcher: chokidar.FSWatcher;
  path: string;          // expanded (no ~)
  events: FileEvent[];
}

function sameEvents(a: readonly FileEvent[], b: readonly FileEvent[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

const active = new Map<string, ActiveWatch>();
const debouncers = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 750;

const DEFAULT_EVENTS: FileEvent[] = ['add', 'change'];

export function registerFileTask(task: TaskRecord, opts: { yomeBinPath: string }): void {
  if (task.trigger.kind !== 'file') return;
  if (!task.enabled) return;
  const rawPath = task.trigger.path;
  if (!rawPath || typeof rawPath !== 'string') {
    // eslint-disable-next-line no-console
    console.error(`[file] task ${task.id}: missing path, skipping`);
    return;
  }
  const expanded = expandTilde(rawPath);
  const events = (task.trigger.events ?? DEFAULT_EVENTS) as FileEvent[];

  // Idempotent re-registration: every recordRun() rewrites tasks.json
  // which fires fs.watch → reloadAllTasks(). If we always tore down the
  // chokidar watcher and rebuilt it, we'd waste ~tens of ms per reload
  // AND briefly drop events that arrive between close() and the new
  // watcher's "ready". When the path + events haven't changed, leave
  // the existing watcher alone.
  const existing = active.get(task.id);
  if (existing && existing.path === expanded && sameEvents(existing.events, events)) {
    return;
  }
  if (existing) {
    unregisterFileTask(task.id);
  }

  const watcher = chokidar.watch(expanded, {
    persistent: true,
    ignoreInitial: true,            // don't fire for files that already exist on startup
    awaitWriteFinish: {             // wait for writes to finish (Excel/atomic rename safety)
      stabilityThreshold: 250,
      pollInterval: 100,
    },
    // Use polling on macOS for network mounts / weird filesystems if
    // we hit issues; default native fsevents is faster and we'll prefer
    // it. The user can override via env if needed.
    usePolling: process.env.YOME_FILE_WATCH_POLL === '1',
  });

  const onEvent = (kind: FileEvent, file: string) => {
    if (!events.includes(kind)) return;
    if (debouncers.has(task.id)) clearTimeout(debouncers.get(task.id)!);
    const t = setTimeout(() => {
      debouncers.delete(task.id);
      runChildTask({
        taskId: task.id,
        yomeBinPath: opts.yomeBinPath,
        task,
        triggerMeta: { triggerKind: 'file', event: kind, file },
      });
    }, DEBOUNCE_MS);
    t.unref?.();
    debouncers.set(task.id, t);
  };

  watcher.on('add', (f) => onEvent('add', f));
  watcher.on('change', (f) => onEvent('change', f));
  watcher.on('unlink', (f) => onEvent('unlink', f));
  watcher.on('error', (e) => {
    // eslint-disable-next-line no-console
    console.error(`[file] task ${task.id}: watcher error:`, e);
  });

  active.set(task.id, { taskId: task.id, watcher, path: expanded, events });
  // eslint-disable-next-line no-console
  console.log(`[file] registered ${task.id} (path="${expanded}", events=[${events.join(',')}])`);
}

export function unregisterFileTask(id: string): void {
  const entry = active.get(id);
  if (!entry) return;
  try { entry.watcher.close(); } catch { /* noop */ }
  active.delete(id);
  const d = debouncers.get(id);
  if (d) { clearTimeout(d); debouncers.delete(id); }
}

export function listActiveFile(): string[] {
  return [...active.keys()];
}

export function unregisterAllFile(): void {
  for (const id of [...active.keys()]) unregisterFileTask(id);
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return homedir() + p.slice(1);
  return p;
}
