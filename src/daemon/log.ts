// JSONL audit log for daemon-run tasks.
// One file per (taskId, runStartTs). Append-only, line-delimited JSON so
// `yome cron logs <id>` can tail / parse it without touching live writers.

import { appendFileSync, readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { logFileForTask, logDirForTask } from './paths.js';

export type LogEntryType =
  | 'run_start'
  | 'run_end'
  | 'tool_use'
  | 'tool_result'
  | 'text_delta'
  | 'permission_denied_auto'
  | 'timeout'
  | 'error';

export interface LogEntry {
  ts: number;            // ms epoch
  type: LogEntryType;
  [k: string]: unknown;
}

export function openTaskLog(taskId: string, runTs: number): string {
  return logFileForTask(taskId, runTs);
}

export function appendLog(file: string, entry: Omit<LogEntry, 'ts'> & { ts?: number }): void {
  const full: LogEntry = { ts: entry.ts ?? Date.now(), ...entry } as LogEntry;
  try {
    appendFileSync(file, JSON.stringify(full) + '\n', 'utf-8');
  } catch {
    // Best-effort: if the log dir vanished mid-run we don't want to crash
    // the agent. The runner already keeps an in-memory error counter.
  }
}

/** List run-log files for a task, newest first. */
export function listRunsForTask(taskId: string): { runTs: number; file: string; sizeBytes: number }[] {
  const dir = logDirForTask(taskId);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const out = files.map((f) => {
    const full = join(dir, f);
    const runTs = Number.parseInt(f.replace('.jsonl', ''), 10) || 0;
    let sizeBytes = 0;
    try { sizeBytes = statSync(full).size; } catch { /* race */ }
    return { runTs, file: full, sizeBytes };
  });
  out.sort((a, b) => b.runTs - a.runTs);
  return out;
}

export function readRunLog(file: string): LogEntry[] {
  try {
    const raw = readFileSync(file, 'utf-8').trim();
    if (!raw) return [];
    const out: LogEntry[] = [];
    for (const line of raw.split('\n')) {
      try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    return out;
  } catch {
    return [];
  }
}
