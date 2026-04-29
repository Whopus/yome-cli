// Top-level CLI entry for `yome daemon ...`.
//
// Subcommands:
//   install     write LaunchAgent plist + launchctl load
//   uninstall   launchctl unload + delete plist
//   start       run the scheduler in the foreground (--foreground) or
//                background (& and detach)
//   stop        send SIGTERM to the running daemon
//   status      print pid + active task count
//   logs [-f]   tail the daemon's stdout/stderr log

import { execSync } from 'child_process';
import { readFileSync, existsSync, openSync } from 'fs';
import { spawn } from 'child_process';
import { startDaemon, readPidIfRunning } from './scheduler.js';
import { installLaunchAgent, uninstallLaunchAgent } from './launchd.js';
import { listTasks } from './taskStore.js';
import { resolveYomeBinPath } from './triggers/cron.js';
import { PID_FILE, STDOUT_LOG, STDERR_LOG, ensureDirs } from './paths.js';

export interface DaemonCliFlags {
  foreground?: boolean;
  follow?: boolean;
}

export async function runDaemonSubcommand(args: string[], flags: DaemonCliFlags): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case 'install':    return doInstall();
    case 'uninstall':  return doUninstall();
    case 'start':      return doStart(flags);
    case 'stop':       return doStop();
    case 'status':     return doStatus();
    case 'logs':       return doLogs(flags);
    case undefined:
    case 'help':
    case '--help':     printHelp(); return 0;
    default:
      console.error(`Unknown subcommand: yome daemon ${sub}`);
      printHelp();
      return 2;
  }
}

function printHelp(): void {
  console.log(`Usage: yome daemon <subcommand>

  install      Install the macOS LaunchAgent (auto-starts on login)
  uninstall    Remove the LaunchAgent
  start        Start the daemon in the foreground (use --foreground via launchd)
  stop         Stop the running daemon (SIGTERM)
  status       Show daemon pid + active task summary
  logs [-f]    Print daemon stdout/stderr (use -f / --follow to tail)

Daemon files:
  ~/.yome/daemon/daemon.pid     pid of the running daemon
  ~/.yome/daemon/stdout.log     scheduler stdout
  ~/.yome/daemon/stderr.log     scheduler stderr
  ~/.yome/cron/tasks.json       task definitions
  ~/.yome/cron/logs/<id>/...    per-run audit logs (jsonl)

See also: yome cron --help`);
}

function doInstall(): number {
  const r = installLaunchAgent(resolveYomeBinPath());
  if (r.ok) { console.log(`✓ ${r.message}`); return 0; }
  console.error(`✗ ${r.message}`);
  return 1;
}

function doUninstall(): number {
  const r = uninstallLaunchAgent();
  if (r.ok) { console.log(`✓ ${r.message}`); return 0; }
  console.error(`✗ ${r.message}`);
  return 1;
}

function doStart(flags: DaemonCliFlags): number {
  const existing = readPidIfRunning();
  if (existing) {
    console.error(`✗ daemon already running (pid=${existing})`);
    return 1;
  }
  ensureDirs();
  if (flags.foreground) {
    // Block here; this is the path launchd uses.
    startDaemon();
    // startDaemon installs signal handlers and the cron jobs keep the
    // event loop alive — we just await forever.
    return new Promise<number>(() => { /* never resolves */ }) as unknown as number;
  }
  // Non-foreground: spawn ourselves as a detached background process so
  // the user gets their shell back. Redirect stdio to the log files
  // shown by `daemon status` and `daemon logs -f` so debug output (e.g.
  // helper child stderr) is recoverable instead of being silently dropped.
  ensureDirs();
  const out = openSync(STDOUT_LOG, 'a');
  const err = openSync(STDERR_LOG, 'a');
  const child = spawn(process.execPath, [resolveYomeBinPath(), 'daemon', 'start', '--foreground'], {
    detached: true,
    stdio: ['ignore', out, err],
  });
  child.unref();
  console.log(`✓ daemon launched in background (pid will be written to ${PID_FILE})`);
  console.log(`  logs:   ${STDOUT_LOG}`);
  return 0;
}

function doStop(): number {
  const pid = readPidIfRunning();
  if (!pid) { console.log('(daemon was not running)'); return 0; }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`✓ sent SIGTERM to pid=${pid}`);
    return 0;
  } catch (e: any) {
    console.error(`✗ failed to stop daemon: ${e?.message ?? e}`);
    return 1;
  }
}

function doStatus(): number {
  const pid = readPidIfRunning();
  const tasks = listTasks();
  const enabled = tasks.filter((t) => t.enabled).length;
  if (!pid) {
    console.log('Status:    not running');
    console.log(`Tasks:     ${tasks.length} total, ${enabled} enabled (daemon must be running to fire them)`);
    console.log(`PID file:  ${PID_FILE}`);
    return 0;
  }
  console.log(`Status:    running (pid=${pid})`);
  console.log(`Tasks:     ${tasks.length} total, ${enabled} enabled`);
  console.log(`PID file:  ${PID_FILE}`);
  console.log(`Logs:      ${STDOUT_LOG}`);
  return 0;
}

function doLogs(flags: DaemonCliFlags): number {
  if (!existsSync(STDOUT_LOG) && !existsSync(STDERR_LOG)) {
    console.log('(no daemon logs yet — start the daemon first)');
    return 0;
  }
  if (flags.follow) {
    // Use tail -F so log rotation / atomic-replace is handled for free.
    try {
      execSync(`tail -F "${STDOUT_LOG}" "${STDERR_LOG}"`, { stdio: 'inherit' });
    } catch { /* tail terminated by user */ }
    return 0;
  }
  // One-shot: print the last 100 lines of each.
  const tail = (file: string) => {
    if (!existsSync(file)) return;
    try {
      const buf = readFileSync(file, 'utf-8');
      const lines = buf.split('\n');
      const last = lines.slice(-100).join('\n');
      console.log(`── ${file} ──`);
      console.log(last);
    } catch { /* noop */ }
  };
  tail(STDOUT_LOG);
  tail(STDERR_LOG);
  return 0;
}
