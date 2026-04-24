// blacklist.ts — local cache + lookups for the hub's skill blacklist.
//
// Lifecycle:
//   - `yome skill install` calls `pingBlacklist(slug)` which (a) refreshes
//     the cache if older than 5 min, (b) returns the matching entry if
//     the slug is denied.
//   - `yome skill list` consults the cache (no network) so it's instant.
//   - The CLI agent runtime, on every skill load, checks
//     `isBlacklistedSync(slug)` against the cache.
//
// The cache lives at ~/.yome/blacklist-cache.json. Format:
//
//     { fetched_at: ISO,
//       entries: [{ slug, reason, detail?, added_at }] }
//
// We intentionally cache even when `entries` is empty so the next `list`
// doesn't need a network call.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface BlacklistEntry {
  slug: string;
  reason: string;
  detail?: string | null;
  added_at: string;
}

export interface BlacklistCache {
  fetched_at: string;
  entries: BlacklistEntry[];
}

export const DEFAULT_HUB_BASE = 'https://yome.work';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function getCachePath(): string {
  return join(homedir(), '.yome', 'blacklist-cache.json');
}

export function readBlacklistCache(): BlacklistCache | null {
  const f = getCachePath();
  if (!existsSync(f)) return null;
  try {
    const obj = JSON.parse(readFileSync(f, 'utf-8'));
    if (!obj || typeof obj !== 'object') return null;
    if (!Array.isArray(obj.entries)) return null;
    return obj as BlacklistCache;
  } catch { return null; }
}

export function writeBlacklistCache(c: BlacklistCache): void {
  const f = getCachePath();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(c, null, 2) + '\n');
}

function isFresh(c: BlacklistCache): boolean {
  const t = Date.parse(c.fetched_at);
  if (!Number.isFinite(t)) return false;
  return (Date.now() - t) < CACHE_TTL_MS;
}

export interface RefreshOptions {
  /** Hub base URL override; default = env YOME_HUB_BASE or https://yome.work. */
  hubBase?: string;
  /** Test seam — replaces global fetch. */
  fetcher?: typeof fetch;
  /** Force refresh even if the cache is still fresh. */
  force?: boolean;
}

/**
 * Pull the latest blacklist from the hub if needed, write it to the
 * cache, return whatever we ended up with. Network errors are swallowed
 * — the previous cache is returned instead so install never breaks
 * because of a transient hub outage.
 */
export async function refreshBlacklist(opts: RefreshOptions = {}): Promise<BlacklistCache> {
  const cached = readBlacklistCache();
  if (cached && isFresh(cached) && !opts.force) return cached;

  const hubBase = (opts.hubBase ?? process.env.YOME_HUB_BASE ?? DEFAULT_HUB_BASE).replace(/\/+$/, '');
  const fetcher = opts.fetcher ?? fetch;
  try {
    const resp = await fetcher(`${hubBase}/api/hub/blacklist`, { headers: { Accept: 'application/json' } });
    if (!resp.ok) return cached ?? { fetched_at: new Date().toISOString(), entries: [] };
    const j = (await resp.json()) as { ok?: boolean; entries?: BlacklistEntry[] };
    if (!j || j.ok !== true || !Array.isArray(j.entries)) {
      return cached ?? { fetched_at: new Date().toISOString(), entries: [] };
    }
    const fresh: BlacklistCache = {
      fetched_at: new Date().toISOString(),
      entries: j.entries.map((e) => ({
        slug: e.slug,
        reason: e.reason,
        detail: e.detail ?? null,
        added_at: e.added_at,
      })),
    };
    writeBlacklistCache(fresh);
    return fresh;
  } catch {
    return cached ?? { fetched_at: new Date().toISOString(), entries: [] };
  }
}

/** Sync lookup against the cache only. Returns the entry or null. */
export function isBlacklistedSync(slug: string): BlacklistEntry | null {
  const c = readBlacklistCache();
  if (!c) return null;
  return c.entries.find((e) => e.slug === slug) ?? null;
}

/** Fetch + check. Use during install. */
export async function pingBlacklist(slug: string, opts: RefreshOptions = {}): Promise<BlacklistEntry | null> {
  const c = await refreshBlacklist(opts);
  return c.entries.find((e) => e.slug === slug) ?? null;
}
