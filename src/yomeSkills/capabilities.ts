// capabilities.ts — declared / granted *system* capabilities for installed
// skills.
//
// Note on naming: yome-skill.json has had a `capabilities` field since
// schema v1, but it's used for *semantic* labels ("calendar:read",
// "ppt:write") that drive the marketplace UI. M9 introduces a separate
// `system_capabilities` field for the security model — the OS-level
// resources a skill needs (fs:read, network, applescript, …). At install
// time we show the user the system_capabilities list and ask "Allow?".
// The decision is persisted to <skillDir>/allowed-capabilities.json. The
// agent runtime later refuses any command that exercises a system
// capability that isn't allowed.
//
// "Official" first-party skills (slug starts with "@yome/") get an
// auto-allow grant — we trust ourselves and don't want to badger the
// user during the bundled install path. Third-party skills always
// prompt unless the user passes `--yes`.
//
// The system-capability vocabulary is deliberately small + frozen for
// v0.1. Anything not in KNOWN_CAPABILITIES is silently dropped from a
// manifest (so the prompt only ever shows things we actually enforce).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { installPathForSlug } from './paths.js';

export const KNOWN_CAPABILITIES = [
  'fs:read',
  'fs:write',
  'fs:delete',
  'applescript',
  'network',
  'shell',
] as const;
export type Capability = (typeof KNOWN_CAPABILITIES)[number];

export interface AllowedCapabilities {
  /** Schema version for forward compatibility. */
  version: 1;
  /** ISO-8601 timestamp when the user (or auto-grant) decided. */
  granted_at: string;
  /** Subset of the manifest's declared capabilities the user said yes to. */
  allowed: Capability[];
  /** "user" / "auto-official" / "yes-flag". */
  granted_by: 'user' | 'auto-official' | 'yes-flag';
}

const HUMAN_DESCRIPTIONS: Record<Capability, string> = {
  'fs:read': 'read files in your home / working directory',
  'fs:write': 'create or modify files in your home / working directory',
  'fs:delete': 'delete files in your home / working directory',
  applescript: 'drive macOS applications via Apple Events (PowerPoint, Calendar, Reminders, …)',
  network: 'make outbound HTTP/HTTPS requests',
  shell: 'run arbitrary shell commands',
};

export function describeCapability(c: Capability): string {
  return HUMAN_DESCRIPTIONS[c] ?? c;
}

/** Strip duplicates and unknown entries from a manifest's `capabilities`. */
export function normaliseDeclared(declared: readonly string[] | undefined): Capability[] {
  if (!declared) return [];
  const seen = new Set<Capability>();
  for (const c of declared) {
    if ((KNOWN_CAPABILITIES as readonly string[]).includes(c)) {
      seen.add(c as Capability);
    }
  }
  return [...seen].sort();
}

export function isOfficialSlug(slug: string): boolean {
  return slug.startsWith('@yome/');
}

function allowedFilePath(slug: string): string | null {
  const dir = installPathForSlug(slug);
  return dir ? join(dir, 'allowed-capabilities.json') : null;
}

export function readAllowedCapabilities(slug: string): AllowedCapabilities | null {
  const f = allowedFilePath(slug);
  if (!f || !existsSync(f)) return null;
  try {
    const obj = JSON.parse(readFileSync(f, 'utf-8'));
    if (obj && typeof obj === 'object' && Array.isArray(obj.allowed)) {
      return obj as AllowedCapabilities;
    }
  } catch { /* ignored */ }
  return null;
}

export function writeAllowedCapabilities(slug: string, ac: AllowedCapabilities): void {
  const f = allowedFilePath(slug);
  if (!f) throw new Error(`cannot derive install dir for ${slug}`);
  writeFileSync(f, JSON.stringify(ac, null, 2) + '\n');
}

/**
 * Decide which capabilities to grant during a fresh install.
 *
 * Rules:
 *   - Empty declared → grant nothing (no prompt).
 *   - Official slug → auto-grant everything declared.
 *   - `assumeYes` (--yes) → grant everything declared, mark "yes-flag".
 *   - Otherwise → ask the user (TTY).
 *     - In non-TTY, default to **deny** (return ok=false, reason).
 */
export interface GrantOptions {
  /** Bypass the prompt and grant everything (CI / -y). */
  assumeYes?: boolean;
  /** Test seam: replace the prompt with a deterministic answer. */
  prompt?: (declared: readonly Capability[], slug: string) => Promise<boolean>;
  /** Test seam: control TTY detection. */
  isTty?: boolean;
  /** Override clock for tests. */
  now?: () => Date;
}

export interface GrantResult {
  ok: boolean;
  granted?: AllowedCapabilities;
  /** Set when ok=false (user declined / non-TTY). */
  reason?: string;
}

export async function decideCapabilities(
  slug: string,
  declared: readonly string[] | undefined,
  opts: GrantOptions = {},
): Promise<GrantResult> {
  const norm = normaliseDeclared(declared);
  const now = (opts.now ?? (() => new Date()))().toISOString();

  if (norm.length === 0) {
    return {
      ok: true,
      granted: { version: 1, allowed: [], granted_at: now, granted_by: 'auto-official' },
    };
  }

  if (isOfficialSlug(slug)) {
    return {
      ok: true,
      granted: { version: 1, allowed: norm, granted_at: now, granted_by: 'auto-official' },
    };
  }

  if (opts.assumeYes) {
    return {
      ok: true,
      granted: { version: 1, allowed: norm, granted_at: now, granted_by: 'yes-flag' },
    };
  }

  // Need a yes/no decision from the human.
  const answer = opts.prompt
    ? await opts.prompt(norm, slug)
    : await defaultPrompt(norm, slug, opts.isTty);

  if (!answer) {
    return { ok: false, reason: 'user declined the capability grant' };
  }
  return {
    ok: true,
    granted: { version: 1, allowed: norm, granted_at: now, granted_by: 'user' },
  };
}

async function defaultPrompt(
  declared: readonly Capability[],
  slug: string,
  isTtyOverride?: boolean,
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stdinTty = (typeof process.stdin === 'object' && (process.stdin as any).isTTY) === true;
  const isTty = isTtyOverride ?? stdinTty;
  if (!isTty) {
    process.stderr.write(
      `! ${slug} requires capabilities (${declared.join(', ')}). ` +
      `Re-run with --yes to allow non-interactively, or in a TTY.\n`,
    );
    return false;
  }

  process.stdout.write(`\n${slug} requests the following capabilities:\n`);
  for (const c of declared) {
    process.stdout.write(`  - ${c}: ${describeCapability(c)}\n`);
  }
  process.stdout.write('Allow? [y/N]: ');

  return await new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.once('line', (line) => {
      rl.close();
      resolve(/^y(es)?$/i.test(line.trim()));
    });
  });
}

/** True iff the skill is currently allowed to use `cap`. */
export function isCapabilityAllowed(slug: string, cap: Capability): boolean {
  const ac = readAllowedCapabilities(slug);
  if (!ac) return false;
  return ac.allowed.includes(cap);
}

/**
 * Revoke a single capability from an installed skill.
 * Returns true if the file was modified.
 */
export function revokeCapability(slug: string, cap: Capability, now: () => Date = () => new Date()): boolean {
  const ac = readAllowedCapabilities(slug);
  if (!ac) return false;
  const before = ac.allowed.length;
  ac.allowed = ac.allowed.filter((x) => x !== cap);
  if (ac.allowed.length === before) return false;
  ac.granted_at = now().toISOString();
  ac.granted_by = 'user';
  writeAllowedCapabilities(slug, ac);
  return true;
}

/** Re-grant a previously revoked capability (must be in the manifest's declared list to take effect). */
export function grantCapability(slug: string, cap: Capability, now: () => Date = () => new Date()): boolean {
  const ac = readAllowedCapabilities(slug) ?? {
    version: 1 as const, allowed: [] as Capability[], granted_at: now().toISOString(), granted_by: 'user' as const,
  };
  if (ac.allowed.includes(cap)) return false;
  ac.allowed = [...ac.allowed, cap].sort();
  ac.granted_at = now().toISOString();
  ac.granted_by = 'user';
  writeAllowedCapabilities(slug, ac);
  return true;
}
