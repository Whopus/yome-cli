// `yome skill deprecate <slug>@<version>` and
// `yome skill sync <slug>` — owner-only mutations against the hub.
//
// Both:
//   - require `yome login` (Authorization: Bearer <yome_token>)
//   - go to /api/hub/skills/<slug>/... endpoints
//   - return a structured result so the cli wrapper can format / --json
//
// Deprecate is fully implemented today (PR 1).
// Sync is a thin client around the 501-stub endpoint until PR 3 ships
// the GitHub App + clone pipeline.

import { readAuthState } from './auth.js';

const DEFAULT_HUB_BASE = 'https://yome.work';

function hubBase(): string {
  return (process.env.YOME_HUB_BASE ?? DEFAULT_HUB_BASE).replace(/\/+$/, '');
}

// ─────────────────────────────────────────────────────────────────────
// deprecate
// ─────────────────────────────────────────────────────────────────────

export interface DeprecateInput {
  slug: string;
  version: string;
  reason: string | null;
  replacedBy: string | null;
  fetcher?: typeof fetch;
}

export interface DeprecateResult {
  ok: boolean;
  slug?: string;
  version?: string;
  alreadyDeprecated?: boolean;
  deprecatedAt?: string | null;
  replacedBy?: string | null;
  reason?: string;
  code?: string;
}

export async function deprecateSkillVersion(input: DeprecateInput): Promise<DeprecateResult> {
  const auth = readAuthState();
  if (!auth) return { ok: false, reason: 'not logged in — run `yome login` first', code: 'unauthenticated' };

  const url =
    `${hubBase()}/api/hub/skills/${encodeURIComponent(input.slug)}/versions/` +
    `${encodeURIComponent(input.version)}/deprecate`;

  const fetcher = input.fetcher ?? fetch;
  let resp: Response;
  try {
    resp = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.yome_token}`,
        'User-Agent': 'yome-cli/0.1',
      },
      body: JSON.stringify({
        reason: input.reason,
        replaced_by: input.replacedBy,
      }),
    });
  } catch (e) {
    return { ok: false, reason: `request failed: ${(e as Error).message}` };
  }
  let parsed: unknown = null;
  try { parsed = await resp.json(); } catch { /* tolerate empty body */ }
  if (!resp.ok) {
    const reason = parsed && typeof parsed === 'object' && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : `HTTP ${resp.status}`;
    const code = parsed && typeof parsed === 'object' && 'code' in parsed
      ? String((parsed as { code: unknown }).code) : undefined;
    return { ok: false, reason, code };
  }
  const obj = parsed as Record<string, unknown>;
  return {
    ok: true,
    slug: obj.slug as string | undefined,
    version: obj.version as string | undefined,
    alreadyDeprecated: Boolean(obj.already_deprecated),
    deprecatedAt: (obj.deprecated_at as string | null | undefined) ?? null,
    replacedBy: (obj.replaced_by_version as string | null | undefined) ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// sync (manual rescue) — PR 1 thin client; server returns 501 until PR 3
// ─────────────────────────────────────────────────────────────────────

export interface SyncInput {
  slug: string;
  fetcher?: typeof fetch;
}

export interface SyncResult {
  ok: boolean;
  slug?: string;
  reason?: string;
  code?: string;
}

export async function syncSkillFromHub(input: SyncInput): Promise<SyncResult> {
  const auth = readAuthState();
  if (!auth) return { ok: false, reason: 'not logged in — run `yome login` first', code: 'unauthenticated' };

  const url = `${hubBase()}/api/hub/skills/${encodeURIComponent(input.slug)}/sync`;
  const fetcher = input.fetcher ?? fetch;
  let resp: Response;
  try {
    resp = await fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.yome_token}`,
        'User-Agent': 'yome-cli/0.1',
      },
    });
  } catch (e) {
    return { ok: false, reason: `request failed: ${(e as Error).message}` };
  }
  let parsed: unknown = null;
  try { parsed = await resp.json(); } catch { /* tolerate */ }
  if (!resp.ok) {
    const reason = parsed && typeof parsed === 'object' && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : `HTTP ${resp.status}`;
    const code = parsed && typeof parsed === 'object' && 'code' in parsed
      ? String((parsed as { code: unknown }).code) : undefined;
    return { ok: false, reason, code };
  }
  return { ok: true, slug: input.slug };
}
