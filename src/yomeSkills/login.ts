// `yome login` — provider-agnostic Yome login.
//
// Yome's identity model: user accounts live in Supabase (auth.users); GitHub
// (and later Apple, WeChat, email) are *providers* attached to that account.
// The CLI cannot hold a Supabase session directly, so the flow is:
//
//   1. Run a provider-specific browser login (currently only GitHub Device
//      Flow).
//   2. Take the provider token (e.g. GitHub access_token), POST it to
//      /api/cli/auth/exchange. The hub:
//        a. verifies the provider token with the provider,
//        b. looks up the matching Yome user (must already exist — i.e.
//           the user must have logged in on the website at least once),
//        c. mints a fresh opaque "yome_token" tied to the Yome user_id.
//   3. Persist {yome_token, yome_user_id, provider, …} to ~/.yome/auth.json.
//
// All future hub calls (publish, install metrics, …) use the yome_token,
// never the GitHub token. The GitHub token never touches disk.
//
// All network calls accept a `fetcher` argument so tests can mock them
// without monkey-patching globalThis.

import { writeAuthState, type YomeAuthState } from './auth.js';

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

// Public OAuth App client_id for the "Yome" GitHub App. Same App as the
// website (Web Flow callback to /auth/github/callback) — Device Flow is
// enabled on the same App, so CLI + browser login share one identity.
// Client IDs are NOT secrets; safe to bake into the published CLI.
const DEFAULT_CLIENT_ID = 'Ov23li25VzpbbfedkWOB';
const DEFAULT_SCOPES = 'read:user';

const DEFAULT_HUB_BASE = 'https://yome.work';

export function getClientId(): string {
  return process.env.YOME_GITHUB_CLIENT_ID || DEFAULT_CLIENT_ID;
}

export function getHubBase(): string {
  return process.env.YOME_HUB_BASE || DEFAULT_HUB_BASE;
}

interface DeviceCodeResp {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResp {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | string;
  error_description?: string;
  interval?: number;
}

interface ExchangeResp {
  ok: boolean;
  yome_token?: string;
  user_id?: string;
  login?: string;
  expires_at?: string;
  error?: string;
  code?: string;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

// Default fetcher.
//
// Node's bundled undici defaults to a 10-second `connectTimeout` which
// is unrealistic for GitHub from networks with high TLS-handshake
// latency (notably mainland China). We install a long-timeout dispatcher
// so that `fetch()` won't abort during the TLS handshake.
//
// We use a dynamic import of undici from the Node internals; if for any
// reason that fails (e.g. we're on a runtime without undici) we just
// fall back to the bare fetch and rely on the request-side AbortController.

let _patchedAgent: unknown;
async function getDispatcher(): Promise<unknown | null> {
  if (_patchedAgent !== undefined) return _patchedAgent as unknown ?? null;
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: built-in module not typed in lib
    const undici = await import('node:undici').catch(() => null) ?? await import('undici').catch(() => null);
    if (!undici || !(undici as { Agent?: new (opts: unknown) => unknown }).Agent) {
      _patchedAgent = null;
      return null;
    }
    const Agent = (undici as { Agent: new (opts: unknown) => unknown }).Agent;
    _patchedAgent = new Agent({
      connect: { timeout: 60_000 },
      headersTimeout: 60_000,
      bodyTimeout: 60_000,
    });
    return _patchedAgent;
  } catch {
    _patchedAgent = null;
    return null;
  }
}

const realFetcher: Fetcher = async (url, init) => {
  // Per-call AbortController as belt-and-braces. `dispatcher` is the
  // primary remedy (controls TLS-handshake time); the controller catches
  // anything that slips past.
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 90_000);
  const dispatcher = await getDispatcher();
  const finalInit: RequestInit = {
    ...init,
    signal: controller.signal,
    // Add the dispatcher only when undici is available; fetch will
    // ignore unknown keys when running on plain node.
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit;
  try {
    return await fetch(url, finalInit);
  } finally {
    clearTimeout(t);
  }
};

export interface LoginOptions {
  clientId?: string;
  scopes?: string;
  /** Override polling for tests (default = response.interval seconds). */
  pollIntervalMs?: number;
  /** Hard ceiling so test runs don't hang forever (default 600_000). */
  timeoutMs?: number;
  /** Test seam. */
  fetcher?: Fetcher;
  /** Hub base URL override (default: env YOME_HUB_BASE or https://yome.work). */
  hubBase?: string;
  /** Test seam — called with the verification URI; default = console.log. */
  onPrompt?: (info: DeviceCodeResp) => void;
  /** Test seam — sleep override. Default uses setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface LoginResult {
  ok: boolean;
  state?: YomeAuthState;
  reason?: string;
  /** Distinguishable error code so the CLI can give a friendly message. */
  code?: 'no_client_id' | 'github_failed' | 'user_denied' | 'expired'
       | 'timeout' | 'exchange_failed' | 'yome_user_not_found' | 'network';
}

export async function performLogin(opts: LoginOptions = {}): Promise<LoginResult> {
  const clientId = opts.clientId ?? getClientId();
  const scopes = opts.scopes ?? DEFAULT_SCOPES;
  const fetcher = opts.fetcher ?? realFetcher;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const hubBase = (opts.hubBase ?? getHubBase()).replace(/\/+$/, '');

  if (!clientId || clientId.startsWith('Iv1.PLACEHOLDER')) {
    return {
      ok: false,
      code: 'no_client_id',
      reason: 'YOME_GITHUB_CLIENT_ID is not configured. Ask a yome.work maintainer for the OAuth App client_id and re-run with that env var set.',
    };
  }

  // ── Phase 1 — GitHub Device Flow → ephemeral GitHub token ──────────
  const dcResp = await fetcher(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: scopes }),
  });
  if (!dcResp.ok) {
    return { ok: false, code: 'github_failed', reason: `device_code request failed: HTTP ${dcResp.status}` };
  }
  const dc = (await dcResp.json()) as DeviceCodeResp;
  if (!dc.user_code || !dc.device_code) {
    return { ok: false, code: 'github_failed', reason: 'device_code response missing fields' };
  }

  if (opts.onPrompt) opts.onPrompt(dc);
  else printPrompt(dc);

  let githubToken: string | null = null;
  const start = Date.now();
  let intervalMs = (opts.pollIntervalMs ?? dc.interval * 1000) || 5000;
  while (Date.now() - start < timeoutMs) {
    await sleep(intervalMs);
    const tResp = await fetcher(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        device_code: dc.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    if (!tResp.ok) continue;
    const tok = (await tResp.json()) as TokenResp;
    if (tok.access_token) { githubToken = tok.access_token; break; }
    if (tok.error === 'authorization_pending') continue;
    if (tok.error === 'slow_down') { intervalMs += 5000; continue; }
    if (tok.error === 'access_denied') return { ok: false, code: 'user_denied', reason: 'user denied authorisation' };
    if (tok.error === 'expired_token') return { ok: false, code: 'expired', reason: 'device code expired before authorisation' };
    return { ok: false, code: 'github_failed', reason: tok.error_description || tok.error || 'unknown token error' };
  }
  if (!githubToken) return { ok: false, code: 'timeout', reason: 'timed out waiting for authorisation' };

  // ── Phase 2 — exchange GitHub token for a Yome CLI token ───────────
  const exResp = await fetcher(`${hubBase}/api/cli/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'github',
      github_token: githubToken,
      client_label: defaultClientLabel(),
    }),
  });
  let exJson: ExchangeResp;
  try { exJson = (await exResp.json()) as ExchangeResp; }
  catch { return { ok: false, code: 'network', reason: `exchange returned non-JSON (HTTP ${exResp.status})` }; }
  if (!exResp.ok || !exJson.ok || !exJson.yome_token || !exJson.user_id) {
    if (exJson.code === 'yome_user_not_found') {
      return {
        ok: false,
        code: 'yome_user_not_found',
        reason: exJson.error ?? 'GitHub account is not linked to a Yome account yet — please sign in once at https://yome.work to link.',
      };
    }
    return {
      ok: false,
      code: 'exchange_failed',
      reason: exJson.error ?? `exchange failed: HTTP ${exResp.status}`,
    };
  }

  const state: YomeAuthState = {
    yome_token: exJson.yome_token,
    yome_user_id: exJson.user_id,
    provider: 'github',
    provider_login: exJson.login,
    expires_at: exJson.expires_at ?? '',
    obtained_at: new Date().toISOString(),
  };
  writeAuthState(state);
  return { ok: true, state };
}

function printPrompt(dc: DeviceCodeResp): void {
  console.log('');
  console.log('  ─── GitHub authorisation required ───');
  console.log(`    Open: ${dc.verification_uri}`);
  console.log(`    Code: ${dc.user_code}`);
  console.log(`  (Code expires in ${Math.round(dc.expires_in / 60)} minutes)`);
  console.log('');
  console.log('Waiting for you to authorise…');
}

function defaultClientLabel(): string {
  // "yome-cli on darwin"   → cheap human-readable hint for the future
  // "active sessions" panel on the website. Not security-critical.
  try {
    return `yome-cli on ${process.platform}`;
  } catch {
    return 'yome-cli';
  }
}
