// CLI-side auth state for `yome login` / `yome whoami` / hub-authenticated
// commands like `yome skill publish`.
//
// Yome's identity model:
//   - Yome user (Supabase auth.users) is the principal.
//   - GitHub / Apple / WeChat / email are *providers* attached to that user.
//   - The CLI cannot hold a Supabase session, so after the user authenticates
//     against any provider, the hub mints us an opaque "yome_token" tied to
//     the Yome user_id. That token is what we persist here.
//
// We store a single JSON file at ~/.yome/auth.json with mode 0600. Token is
// plaintext — same trust model as gh CLI's keyring fallback / npm's
// authToken — but with strict perms so other local users cannot read it.
//
// Why no encryption: a passphrase prompt every command would defeat the
// point of CLI auth, and any keychain integration is platform-specific
// (macOS Security framework, Linux libsecret). Plain mode 0600 is the
// pragmatic baseline.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync,
} from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

export interface YomeAuthState {
  /** Opaque token issued by /api/cli/auth/exchange. 64 hex chars. */
  yome_token: string;
  /** Supabase auth.users.id — the Yome principal. */
  yome_user_id: string;
  /** Provider used at login time ("github" today; future: apple/wechat/email). */
  provider: 'github' | 'apple' | 'email' | 'wechat';
  /** Provider-side display name at login time, for whoami output. */
  provider_login?: string;
  /** ISO-8601 timestamp the token expires. */
  expires_at: string;
  /** ISO-8601 timestamp the token was first written. */
  obtained_at: string;
}

export function getAuthFilePath(): string {
  return join(homedir(), '.yome', 'auth.json');
}

export function readAuthState(): YomeAuthState | null {
  const f = getAuthFilePath();
  if (!existsSync(f)) return null;
  try {
    const text = readFileSync(f, 'utf-8');
    const obj = JSON.parse(text);
    if (typeof obj !== 'object' || obj == null) return null;
    if (typeof obj.yome_token !== 'string' || typeof obj.yome_user_id !== 'string') return null;
    return obj as YomeAuthState;
  } catch {
    return null;
  }
}

export function writeAuthState(state: YomeAuthState): void {
  const f = getAuthFilePath();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  // mode in writeFileSync only applies on file CREATION; chmod again to
  // guarantee the perms even when the file existed already.
  try { chmodSync(f, 0o600); } catch { /* best effort on Windows */ }
}

export function clearAuthState(): boolean {
  const f = getAuthFilePath();
  if (!existsSync(f)) return false;
  try { unlinkSync(f); return true; } catch { return false; }
}

/** Bearer header object suitable for fetch({headers}). null if logged out. */
export function bearerHeader(): Record<string, string> | null {
  const s = readAuthState();
  return s ? { Authorization: `Bearer ${s.yome_token}` } : null;
}
