// PAT → short-lived WS ticket exchange.
//
// We hold a long-lived opaque `yome_token` (from `yome login`) on disk
// and use it to mint short-lived JWTs that PartyKit can verify with the
// existing Supabase-JWT HS256 path. This is the same pattern GitHub
// CLI / Vercel CLI / Supabase CLI use: never put a service-grade JWT
// or refresh_token on disk; only ever hold a revocable PAT.
//
// See cli/MIGRATION.md "Auth design" for the full rationale.

import { readAuthState } from '../yomeSkills/auth.js';
import { getHubBase } from '../yomeSkills/login.js';
import { getOrCreateDeviceId, safeHostname, currentPlatform } from './device-id.js';
import type { WsTicketRequest, WsTicketResponse } from './types.js';

const TICKET_ENDPOINT_PATH = '/api/cli/mesh/ws-ticket';

/** Stable User-Agent for hub logs. */
function userAgent(): string {
  // Bumping is fine; this is a label, not a contract.
  return `yome-cli/0.x mesh/1 ${currentPlatform()}`;
}

export class MintTicketError extends Error {
  constructor(message: string, public code: string, public httpStatus?: number) {
    super(message);
    this.name = 'MintTicketError';
  }
}

/**
 * Request a fresh WS ticket. The caller is responsible for caching
 * (TicketCache below). Throws MintTicketError on any failure.
 */
export async function mintWsTicket(opts: {
  hubBase?: string;
  fetcher?: typeof fetch;
  cliVersion?: string;
} = {}): Promise<WsTicketResponse> {
  const auth = readAuthState();
  if (!auth?.yome_token) {
    throw new MintTicketError(
      'Not logged in. Run `yome login` first.',
      'not_logged_in',
    );
  }

  const hubBase = (opts.hubBase ?? getHubBase()).replace(/\/+$/, '');
  const fetcher = opts.fetcher ?? fetch;

  const body: WsTicketRequest = {
    deviceId: getOrCreateDeviceId(),
    hostname: safeHostname(),
    platform: currentPlatform(),
    cliVersion: opts.cliVersion,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let resp: Response;
  try {
    resp = await fetcher(`${hubBase}${TICKET_ENDPOINT_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${auth.yome_token}`,
        'User-Agent': userAgent(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new MintTicketError(
      `Network error contacting hub: ${(err as Error).message}`,
      'network',
    );
  } finally {
    clearTimeout(timer);
  }

  let json: WsTicketResponse | { error?: string; code?: string };
  try {
    json = await resp.json() as WsTicketResponse;
  } catch {
    throw new MintTicketError(
      `Hub returned non-JSON (HTTP ${resp.status}).`,
      'bad_response',
      resp.status,
    );
  }

  if (!resp.ok || !(json as WsTicketResponse).ok) {
    const e = json as { error?: string; code?: string };
    throw new MintTicketError(
      e.error ?? `Hub rejected ticket request (HTTP ${resp.status}).`,
      e.code ?? 'hub_error',
      resp.status,
    );
  }
  const ok = json as WsTicketResponse;
  if (!ok.ws_token || !ok.userId || !ok.partykit_host) {
    throw new MintTicketError(
      'Hub response missing required fields (ws_token / userId / partykit_host).',
      'bad_response',
      resp.status,
    );
  }
  return ok;
}

/**
 * Tiny in-memory cache that proactively refreshes the ticket before it
 * expires. Owned by the long-running mesh daemon process. NOT persisted
 * to disk — short-lived JWTs are deliberately ephemeral.
 *
 * Refresh strategy: re-mint when ≤ 60s remains. PartyKit only checks
 * the JWT at WS handshake time (not per message), so we don't strictly
 * need to refresh during a live connection — but we cache for reconnects.
 */
export class TicketCache {
  private current: WsTicketResponse | null = null;
  private expiresAtMs = 0;
  private inflight: Promise<WsTicketResponse> | null = null;

  constructor(private mintFn: () => Promise<WsTicketResponse> = mintWsTicket) {}

  async get(): Promise<WsTicketResponse> {
    const now = Date.now();
    const safetyWindowMs = 60_000;
    if (this.current && now < this.expiresAtMs - safetyWindowMs) {
      return this.current;
    }
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const fresh = await this.mintFn();
      this.current = fresh;
      this.expiresAtMs = Date.now() + fresh.expires_in * 1000;
      return fresh;
    })();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  invalidate(): void {
    this.current = null;
    this.expiresAtMs = 0;
  }
}
