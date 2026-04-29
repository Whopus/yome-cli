// One-shot trigger: a task that fires exactly once at a specified
// wall-clock time. After firing, the task is automatically disabled so
// it won't be re-armed on daemon restart.
//
// Storage shape: { kind: 'once', atMs: <epoch_ms> }
//
// Past-due semantics: if the daemon starts AFTER atMs, we still fire
// once (immediately) — the user said "do this thing eventually", and
// silently skipping it is worse than late delivery. They can `cron rm`
// before starting the daemon if they want to cancel.

import type { TaskRecord } from '../taskStore.js';
import { setEnabled } from '../taskStore.js';
import { runChildTask } from './childRunner.js';

interface PendingFire {
  taskId: string;
  timer: NodeJS.Timeout;
  scheduledFor: number;
}

const pending = new Map<string, PendingFire>();

const PAST_DUE_DELAY_MS = 1_000; // small delay to avoid thundering at startup

export function registerOnceTask(task: TaskRecord, opts: { yomeBinPath: string }): void {
  if (task.trigger.kind !== 'once') return;
  if (!task.enabled) return;
  const atMs = task.trigger.atMs;
  if (typeof atMs !== 'number' || Number.isNaN(atMs)) {
    // eslint-disable-next-line no-console
    console.error(`[once] task ${task.id}: invalid atMs ${atMs}, skipping`);
    return;
  }

  // Idempotent re-registration: tasks.json gets rewritten every time
  // ANY task records a run (recordRun → atomic write), which triggers
  // the scheduler's fs.watch and a full reloadAllTasks(). Without the
  // guard below, that re-entry would clearTimeout() our pending fire
  // and setTimeout() a fresh one — resetting the countdown each time,
  // and (worse) racing with the just-fired callback so we'd run the
  // task twice within milliseconds. Skipping when nothing changed
  // makes reload a no-op for already-armed once timers.
  const existing = pending.get(task.id);
  if (existing && existing.scheduledFor === atMs) {
    return;
  }
  if (existing) {
    unregisterOnceTask(task.id);
  }
  const now = Date.now();
  const delay = Math.max(PAST_DUE_DELAY_MS, atMs - now);
  // eslint-disable-next-line no-console
  console.log(
    `[once] registered ${task.id} (fires at ${new Date(atMs).toISOString()}` +
    `${atMs < now ? ', past-due → firing soon' : ''})`,
  );
  const timer = setTimeout(() => {
    pending.delete(task.id);
    runChildTask({
      taskId: task.id,
      yomeBinPath: opts.yomeBinPath,
      task,
      triggerMeta: { triggerKind: 'once', atMs },
      onComplete: () => {
        // Disable the task so it doesn't re-fire if the daemon restarts.
        // The lastRun summary is what survives in tasks.json.
        setEnabled(task.id, false);
      },
    });
  }, delay);
  // Don't keep the daemon event loop alive solely on this timer — the
  // scheduler's other mechanisms (cron jobs, file watchers) keep it
  // alive, and on shutdown we want clean exit.
  timer.unref?.();
  pending.set(task.id, { taskId: task.id, timer, scheduledFor: atMs });
}

export function unregisterOnceTask(id: string): void {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
}

export function listActiveOnce(): { taskId: string; scheduledFor: number }[] {
  return [...pending.values()].map((p) => ({ taskId: p.taskId, scheduledFor: p.scheduledFor }));
}

export function unregisterAllOnce(): void {
  for (const id of [...pending.keys()]) unregisterOnceTask(id);
}
