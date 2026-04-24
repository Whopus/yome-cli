// `yome skill search <query>` — call the hub's catalogue and render
// either a table or JSON.

export interface SearchHit {
  slug: string;
  domain: string;
  name: string | null;
  description: string | null;
  is_official: boolean;
  star_count: number;
  install_count: number;
  github_full_name: string | null;
  latest_version: string | null;
}

export interface SearchOptions {
  hubBase?: string;
  limit?: number;
  fetcher?: typeof fetch;
}

const DEFAULT_HUB_BASE = 'https://yome.work';

export async function searchHub(query: string, opts: SearchOptions = {}): Promise<{ ok: boolean; hits: SearchHit[]; reason?: string }> {
  const hubBase = (opts.hubBase ?? process.env.YOME_HUB_BASE ?? DEFAULT_HUB_BASE).replace(/\/$/, '');
  const limit = opts.limit ?? 25;
  const url = `${hubBase}/api/hub/skills?q=${encodeURIComponent(query)}&limit=${limit}`;
  const fetcher = opts.fetcher ?? fetch;
  let resp;
  try {
    resp = await fetcher(url, { headers: { Accept: 'application/json', 'User-Agent': 'yome-cli/0.1' } });
  } catch (e) {
    return { ok: false, hits: [], reason: `network error: ${(e as Error).message}` };
  }
  if (!resp.ok) {
    return { ok: false, hits: [], reason: `hub returned HTTP ${resp.status}` };
  }
  let body: unknown;
  try { body = await resp.json(); } catch { return { ok: false, hits: [], reason: 'invalid JSON from hub' }; }
  const arr = Array.isArray(body) ? body
    : (body && typeof body === 'object' && 'hits' in body && Array.isArray((body as { hits: unknown }).hits))
      ? (body as { hits: SearchHit[] }).hits : [];
  return { ok: true, hits: arr as SearchHit[] };
}
