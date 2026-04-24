// Best-effort ping to the hub so install_count goes up.
//
// Intentionally:
//   - never throws (catches everything)
//   - never blocks longer than ~3s
//   - does nothing if YOME_HUB_PING_DISABLED=1 or YOME_HUB_BASE points
//     at a non-http(s) value
//   - silent on success, only logs on failure when YOME_VERBOSE=1
//
// The hub endpoint /api/hub/skills/<slug>/install is anonymous (rate-limited
// per IP) so we don't need to send any credentials.
//
// Returns a promise the caller MAY await. The CLI awaits a short bounded
// time so the request actually leaves the box before the process exits;
// other callers can ignore the promise.

const DEFAULT_HUB_BASE = 'https://yome.work';

export function pingHubInstall(slug: string): Promise<void> {
  if (process.env.YOME_HUB_PING_DISABLED === '1') return Promise.resolve();
  if (!slug) return Promise.resolve();
  const base = (process.env.YOME_HUB_BASE || DEFAULT_HUB_BASE).replace(/\/$/, '');
  if (!/^https?:\/\//.test(base)) return Promise.resolve();

  const url = `${base}/api/hub/skills/${encodeURIComponent(slug)}/install`;
  const verbose = process.env.YOME_VERBOSE === '1';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);

  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'yome-cli/0.1' },
    body: '{}',
    signal: ctrl.signal,
  })
    .then((r) => { if (verbose) console.error(`hub ping ${slug}: ${r.status}`); })
    .catch((e) => { if (verbose) console.error(`hub ping ${slug} failed: ${(e as Error).message}`); })
    .finally(() => clearTimeout(timer));
}
