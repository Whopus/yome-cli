// cli/src/skills/runner/applescript.ts
//
// Spawn /usr/bin/osascript and friends. Mirror of Yome/macOS/Bridge/
// AppleScriptRunner.swift so the CLI gets the same execution semantics
// the macOS app uses (including the Launch Services trick that bypasses
// app-sandbox prompts for opening files).

import { spawnSync } from 'node:child_process';

export interface AppleScriptResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** osascript exit code (0 on success). -1 on launch failure. */
  exitCode: number;
}

/**
 * Run an AppleScript source string via `osascript -e`.
 *
 * The Swift sibling does some preflight automation-permission checks via
 * AEDeterminePermissionToAutomateTarget. CLI doesn't have a UI to drive
 * the system prompt, so we just let osascript surface error -1743 — the
 * caller can decide whether to message the user.
 */
export function runOsascript(source: string, opts: { timeoutMs?: number } = {}): AppleScriptResult {
  const r = spawnSync('/usr/bin/osascript', ['-e', source], {
    encoding: 'utf-8',
    timeout: opts.timeoutMs ?? 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.error) {
    return { ok: false, stdout: '', stderr: String(r.error.message), exitCode: -1 };
  }
  const code = r.status ?? -1;
  return {
    ok: code === 0,
    stdout: (r.stdout ?? '').replace(/\n+$/, ''),
    stderr: (r.stderr ?? '').trim(),
    exitCode: code,
  };
}

/**
 * Same as `runOsascript`, but reads the script from a file path instead
 * of inline `-e`. Useful for very long scripts or when keeping a single
 * authoritative `.applescript` file in the skill bundle.
 */
export function runOsascriptFile(path: string, opts: { timeoutMs?: number } = {}): AppleScriptResult {
  const r = spawnSync('/usr/bin/osascript', [path], {
    encoding: 'utf-8',
    timeout: opts.timeoutMs ?? 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.error) {
    return { ok: false, stdout: '', stderr: String(r.error.message), exitCode: -1 };
  }
  const code = r.status ?? -1;
  return {
    ok: code === 0,
    stdout: (r.stdout ?? '').replace(/\n+$/, ''),
    stderr: (r.stderr ?? '').trim(),
    exitCode: code,
  };
}

/**
 * Open a file via macOS Launch Services (`/usr/bin/open -a`) so the
 * receiving app gets sandbox-implicit access without us having to fight
 * automation prompts, then poll an AppleScript until the file shows up
 * inside that app.
 *
 * Returns the poll script's last output on success, or null on timeout.
 */
export function openViaLaunchServices(args: {
  filePath: string;
  appName: string;
  pollScript: string;
  maxWaitSec?: number;
  pollIntervalMs?: number;
}): { ok: boolean; stdout: string; stderr: string } {
  const open = spawnSync('/usr/bin/open', ['-a', args.appName, args.filePath], { encoding: 'utf-8' });
  if (open.status !== 0) {
    return {
      ok: false,
      stdout: '',
      stderr: open.stderr || `open -a "${args.appName}" exited ${open.status}`,
    };
  }

  const max = args.maxWaitSec ?? 30;
  const interval = args.pollIntervalMs ?? 1000;
  for (let i = 0; i < max; i++) {
    sleepSync(interval);
    const r = runOsascript(args.pollScript);
    if (r.ok && r.stdout.trim().length > 0) {
      return { ok: true, stdout: r.stdout, stderr: '' };
    }
  }
  return { ok: false, stdout: '', stderr: `timed out waiting for ${args.appName} to load ${args.filePath}` };
}

/** Quote a string so it's safe to embed inside an AppleScript string literal. */
export function asString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Quote a POSIX path for AppleScript ("POSIX file" wrapping is the caller's job). */
export function asPosixPath(p: string): string {
  return asString(p);
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  // Atomics-based sleep — works in Node ≥16 without spawning a child.
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  while (Date.now() < end) {
    Atomics.wait(view, 0, 0, Math.max(1, end - Date.now()));
  }
}
