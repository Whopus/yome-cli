// capabilityGuard.ts — runtime gate that the bash-tool intercept layer
// (and any future skill dispatcher) calls before letting an installed
// skill exercise an OS capability.
//
// Spec ref: 7.6 ("capability 强制 — runtime dispatch 前检查命令是否在 skill
// 声明的 capabilities 内，越权拒绝") + 11.4-D row "permissions/ —
// checkSkillCapability".
//
// The actual dispatcher is M5+ (spec §11.4-F step 3). This module exists
// so the security primitive is in place and unit-testable now: when the
// dispatcher lands, the only call site is `assertCapability(slug, cap)`
// and we get a single source of truth for the allow/deny logic.
//
// Design choices:
//   * We consult the same `allowed-capabilities.json` sidecar that the
//     install-time prompt writes — there is no separate "runtime" grant
//     store. Symmetry between install-time consent and run-time check is
//     the whole point.
//   * We DO NOT consult the *manifest's* declared list at runtime. A skill
//     that revoked a capability via `yome skill perms <slug> --revoke`
//     should be denied even if the manifest still declares it.
//   * Bundled official skills (slug starts with `@yome/`) are treated as
//     pre-trusted IF their allowed-cap sidecar is missing — they ship
//     with the binary, so they never went through the prompt. If a
//     sidecar IS present (e.g. user revoked one), it wins.
//   * Telemetry: every denial increments an in-memory counter the doctor
//     command can surface as "skill X tried to use Y N times — investigate".

import { readAllowedCapabilities, normaliseDeclared, type Capability } from './capabilities.js';
import { readManifest } from './manifest.js';
import { installPathForSlug } from './paths.js';

export interface CapDecision {
  allowed: boolean;
  /** Human-readable reason on denial (suitable for printing to the user). */
  reason?: string;
  /** Where the decision came from — useful in logs. */
  source: 'sidecar' | 'official-no-sidecar' | 'unknown-skill' | 'unknown-cap';
}

const denialCounters = new Map<string, number>();   // `${slug}::${cap}` → count

function bumpDenial(slug: string, cap: string): void {
  const k = `${slug}::${cap}`;
  denialCounters.set(k, (denialCounters.get(k) ?? 0) + 1);
}

/** Snapshot of denials since process start. Used by `yome skill doctor` v2. */
export function getDenialCounts(): Array<{ slug: string; capability: string; count: number }> {
  return Array.from(denialCounters.entries())
    .map(([k, count]) => {
      const [slug, capability] = k.split('::');
      return { slug, capability, count };
    })
    .sort((a, b) => b.count - a.count);
}

/** Reset counters (test seam). */
export function resetDenialCounts(): void {
  denialCounters.clear();
}

const isOfficial = (slug: string): boolean => slug.startsWith('@yome/');

/**
 * Synchronous capability check — safe to call from inside a tool dispatch
 * hot path. Reads two small files (manifest + allowed-cap sidecar) but
 * does not block on network or DB.
 *
 * @returns Decision with `allowed: true` ⇒ proceed; otherwise deny and
 * surface `reason` to the LLM so it can pick a different action.
 */
export function checkCapability(slug: string, cap: Capability | string): CapDecision {
  const dir = installPathForSlug(slug);
  if (!dir) {
    return { allowed: false, source: 'unknown-skill', reason: `unknown skill slug: ${slug}` };
  }
  const manifest = readManifest(dir);
  if (!manifest) {
    return { allowed: false, source: 'unknown-skill', reason: `${slug}: manifest missing` };
  }

  const declared = new Set(normaliseDeclared(manifest.system_capabilities));
  if (!declared.has(cap as Capability)) {
    bumpDenial(slug, String(cap));
    return {
      allowed: false,
      source: 'unknown-cap',
      reason: `${slug} did not declare capability "${cap}" in its manifest — refused.`,
    };
  }

  const allowed = readAllowedCapabilities(slug);
  if (!allowed) {
    // No sidecar: official skills are pre-trusted; everyone else is denied
    // (defensive default — better to fail closed than to silently grant).
    if (isOfficial(slug)) {
      return { allowed: true, source: 'official-no-sidecar' };
    }
    bumpDenial(slug, String(cap));
    return {
      allowed: false,
      source: 'sidecar',
      reason: `${slug} has no capability grant on file — run \`yome skill perms ${slug} --grant=${cap}\` first.`,
    };
  }

  if (allowed.allowed.includes(cap as Capability)) {
    return { allowed: true, source: 'sidecar' };
  }

  bumpDenial(slug, String(cap));
  return {
    allowed: false,
    source: 'sidecar',
    reason: `${slug}: capability "${cap}" was revoked. Re-grant with \`yome skill perms ${slug} --grant=${cap}\`.`,
  };
}

/**
 * Throwing variant — convenience for dispatchers that prefer exceptions
 * over decision objects. Errors are tagged so callers can render them
 * cleanly to the LLM.
 */
export function assertCapability(slug: string, cap: Capability | string): void {
  const d = checkCapability(slug, cap);
  if (!d.allowed) {
    const err = new Error(d.reason ?? 'capability denied') as Error & { code?: string };
    err.code = 'YOME_CAPABILITY_DENIED';
    throw err;
  }
}
