// Daemon-wide path constants. Centralised so the runner, scheduler, log
// reader and launchd plist generator all agree on where things live.

import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';

export const DAEMON_ROOT = join(homedir(), '.yome', 'daemon');
export const CRON_ROOT = join(homedir(), '.yome', 'cron');
export const TASKS_FILE = join(CRON_ROOT, 'tasks.json');
export const LOGS_ROOT = join(CRON_ROOT, 'logs');
export const PID_FILE = join(DAEMON_ROOT, 'daemon.pid');
export const STDOUT_LOG = join(DAEMON_ROOT, 'stdout.log');
export const STDERR_LOG = join(DAEMON_ROOT, 'stderr.log');
export const PLIST_LABEL = 'work.yome.daemon';

export function ensureDirs(): void {
  mkdirSync(DAEMON_ROOT, { recursive: true });
  mkdirSync(CRON_ROOT, { recursive: true });
  mkdirSync(LOGS_ROOT, { recursive: true });
}

export function logFileForTask(taskId: string, runTs: number): string {
  const dir = join(LOGS_ROOT, taskId);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${runTs}.jsonl`);
}

export function logDirForTask(taskId: string): string {
  return join(LOGS_ROOT, taskId);
}
