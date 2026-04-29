// Persistent task registry for `yome cron`.
//
// File: ~/.yome/cron/tasks.json
// Format: { version: 1, tasks: TaskRecord[] }
//
// We keep the schema flat-ish and forward-compatible: extra fields are
// preserved on round-trip, so future PRs can add (e.g.) calendar / file
// triggers without breaking older daemon binaries.

import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { randomUUID } from 'crypto';
import { TASKS_FILE, ensureDirs } from './paths.js';

export type CalendarEventKind = 'event-start' | 'event-end' | 'event-added';

export type TriggerSpec =
  | { kind: 'cron'; schedule: string; tz?: string }
  | { kind: 'once'; atMs: number }
  | { kind: 'file'; path: string; events?: ('change' | 'add' | 'unlink')[] }
  | {
      kind: 'calendar';
      events: CalendarEventKind[];
      /** For event-start: fire this many ms BEFORE the event begins. Default 0. */
      leadMs?: number;
      /** Optional case-insensitive regex on event title. */
      titleRegex?: string;
      /** Optional case-insensitive substring of calendar display name. */
      calendar?: string;
    };

export interface RunSummary {
  ts: number;
  ok: boolean;
  durationMs: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

export interface TaskRecord {
  id: string;
  createdAt: number;
  trigger: TriggerSpec;
  prompt: string;
  cwd?: string;
  /** Permission allow rules layered onto the agent for this task. */
  autoAllow?: string[];
  /** Permission deny rules — override allow. */
  autoDeny?: string[];
  /** Hard wall-time budget. Default 5 min in runner.ts. */
  maxDurationMs?: number;
  /** Extra environment variables passed to the spawned __run-task child.
   *  Useful for skill-level switches (e.g. YOME_WEB_HEADLESS=0 to open a
   *  visible browser window) without polluting the daemon's own env. */
  env?: Record<string, string>;
  enabled: boolean;
  lastRun?: RunSummary;
  /** Last N run summaries (newest first). Bounded to avoid unbounded growth. */
  history?: RunSummary[];
  /** Free-form description shown in `yome cron list`. */
  note?: string;
}

interface StoreShape {
  version: 1;
  tasks: TaskRecord[];
}

const HISTORY_LIMIT = 20;

function readRaw(): StoreShape {
  if (!existsSync(TASKS_FILE)) return { version: 1, tasks: [] };
  try {
    const raw = readFileSync(TASKS_FILE, 'utf-8').trim();
    if (!raw) return { version: 1, tasks: [] };
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) {
      return { version: 1, tasks: [] };
    }
    return { version: 1, tasks: parsed.tasks as TaskRecord[] };
  } catch {
    return { version: 1, tasks: [] };
  }
}

function writeRaw(store: StoreShape): void {
  ensureDirs();
  // Atomic-ish write via rename to avoid corrupting the file if the
  // daemon dies mid-write (OS will only see the old or the new bytes).
  const tmp = TASKS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, TASKS_FILE);
}

export function listTasks(): TaskRecord[] {
  return readRaw().tasks;
}

export function getTask(id: string): TaskRecord | undefined {
  return readRaw().tasks.find((t) => t.id === id);
}

export function addTask(input: Omit<TaskRecord, 'id' | 'createdAt' | 'enabled'> & {
  enabled?: boolean;
}): TaskRecord {
  const store = readRaw();
  const t: TaskRecord = {
    id: shortId(),
    createdAt: Date.now(),
    enabled: input.enabled ?? true,
    ...input,
  };
  store.tasks.push(t);
  writeRaw(store);
  return t;
}

export function removeTask(id: string): boolean {
  const store = readRaw();
  const before = store.tasks.length;
  store.tasks = store.tasks.filter((t) => t.id !== id);
  if (store.tasks.length === before) return false;
  writeRaw(store);
  return true;
}

export function setEnabled(id: string, enabled: boolean): boolean {
  const store = readRaw();
  const t = store.tasks.find((x) => x.id === id);
  if (!t) return false;
  t.enabled = enabled;
  writeRaw(store);
  return true;
}

export function recordRun(id: string, summary: RunSummary): void {
  const store = readRaw();
  const t = store.tasks.find((x) => x.id === id);
  if (!t) return;
  t.lastRun = summary;
  t.history = [summary, ...(t.history ?? [])].slice(0, HISTORY_LIMIT);
  writeRaw(store);
}

/** Short, sortable-ish task id: tsk_<8 hex chars>. */
function shortId(): string {
  const u = randomUUID().replace(/-/g, '');
  return `tsk_${u.slice(0, 10)}`;
}
