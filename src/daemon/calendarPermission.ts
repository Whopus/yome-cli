// Pre-flight EventKit permission probe for `yome cron add --on calendar:*`.
//
// We invoke the same Swift helper the daemon uses (`yome-calwatch
// --check-access`) — it's the only reliable way to learn the current
// state because TCC is per-binary, not per-user.
//
// Exit codes (mirrors the helper):
//   0  granted
//   2  denied / restricted (with a JSON line describing the fix)
//   3  unknown
//   non-existent binary → returns { ok: false, message: '...' }

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

export interface CalendarAccessResult {
  ok: boolean;
  status: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown' | 'no-helper';
  message: string;
  /** Hint surfaced from the Swift helper (e.g. "open System Settings → ..."). */
  fix?: string;
}

/** Best-effort path to bin/yome-calwatch. */
export function resolveCalwatchPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/daemon/calendarPermission.js  → ../../bin/yome-calwatch
  // src/daemon/calendarPermission.ts   → ../../bin/yome-calwatch
  return resolve(here, '..', '..', 'bin', 'yome-calwatch');
}

export function checkCalendarAccess(): CalendarAccessResult {
  const bin = resolveCalwatchPath();
  if (!existsSync(bin)) {
    return {
      ok: false,
      status: 'no-helper',
      message:
        'native helper yome-calwatch is missing. ' +
        'On macOS: cd cli && npm run build:native. ' +
        'On Linux/Windows: calendar triggers are macOS-only.',
    };
  }
  const r = spawnSync(bin, ['--check-access'], { encoding: 'utf-8', timeout: 30_000 });
  // Helper writes one JSON line to stdout regardless of exit code.
  const last = (r.stdout ?? '').split('\n').reverse().find((l) => l.trim().startsWith('{'));
  let parsed: Record<string, unknown> = {};
  if (last) { try { parsed = JSON.parse(last); } catch { /* noop */ } }

  const status = String(parsed.status ?? '');
  const fix = typeof parsed.fix === 'string' ? parsed.fix : undefined;

  if (r.status === 0 && status === 'granted') {
    return { ok: true, status: 'granted', message: 'calendar access granted' };
  }
  if (status === 'denied' || status === 'restricted') {
    return {
      ok: false,
      status: status as 'denied' | 'restricted',
      message: `calendar access ${status}`,
      fix,
    };
  }
  if (status === 'not-determined') {
    return { ok: false, status: 'not-determined', message: 'calendar access not yet determined', fix };
  }
  return {
    ok: false,
    status: 'unknown',
    message:
      `unable to determine calendar access (helper exit=${r.status}). ` +
      `stdout=${(r.stdout ?? '').slice(0, 200)} stderr=${(r.stderr ?? '').slice(0, 200)}`,
    fix,
  };
}
