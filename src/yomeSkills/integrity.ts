// integrity.ts — content-addressed hash of an installed/source skill.
//
// Threat model: a user runs `yome skill install github:Whopus/foo`. Between
// `git clone` and the bytes landing in ~/.yome/skills the network /
// CDN / GitHub mirror could substitute different content. We give the
// hub a sha256 fingerprint at publish time; install verifies it matches.
//
// Algorithm (deliberately simple, deterministic, and language-agnostic):
//
//   1. Walk the skill directory recursively, collect every file path
//      relative to the skill root, except those in DEFAULT_IGNORES.
//   2. Sort paths byte-wise (NFC, no normalisation — "what's on disk").
//   3. Build a stream of records:
//        <relative path> NUL <byte length, ASCII> NUL <file bytes> NUL
//   4. Return the SHA-256 hex digest of the concatenated stream.
//
// Properties:
//   - Same directory tree → same digest, regardless of OS readdir order.
//   - Adding/removing/renaming any file changes the digest.
//   - Filesystem perms / mtime do NOT affect the digest (intentionally —
//     `git clone` resets times, and installing copies don't preserve them).

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Files & directories that should never contribute to a skill hash.
 * - VCS plumbing (.git/) is environmental, not skill content.
 * - .install-meta.json / .yome-disabled / allowed-capabilities.json are
 *   per-install state files we write *after* the bytes land — including
 *   them would create chicken-and-egg.
 * - Build artefacts (node_modules, dist, .DS_Store) are noise.
 */
export const DEFAULT_IGNORES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  '.DS_Store',
  '.install-meta.json',
  '.yome-disabled',
  'allowed-capabilities.json',
]);

export interface ComputeOptions {
  /** Override the default ignore set entirely. */
  ignores?: ReadonlySet<string>;
}

/**
 * Walk dir → return relative paths (slash-separated for portability)
 * sorted byte-wise.
 */
function listFiles(root: string, ignores: ReadonlySet<string>): string[] {
  const out: string[] = [];
  function walk(abs: string): void {
    let entries: string[];
    try { entries = readdirSync(abs); }
    catch { return; }
    for (const e of entries) {
      if (ignores.has(e)) continue;
      const p = join(abs, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        // Normalise to forward-slash so digests are stable cross-platform.
        out.push(relative(root, p).split(sep).join('/'));
      }
    }
  }
  walk(root);
  out.sort();
  return out;
}

/**
 * Compute the canonical sha256 of a skill directory.
 * Returns the hex digest (64 chars).
 */
export function computeSkillSha256(skillDir: string, opts: ComputeOptions = {}): string {
  const ignores = opts.ignores ?? DEFAULT_IGNORES;
  const files = listFiles(skillDir, ignores);
  const h = createHash('sha256');
  const NUL = Buffer.from([0]);
  for (const rel of files) {
    const bytes = readFileSync(join(skillDir, rel));
    h.update(rel, 'utf-8');
    h.update(NUL);
    h.update(String(bytes.byteLength), 'utf-8');
    h.update(NUL);
    h.update(bytes);
    h.update(NUL);
  }
  return h.digest('hex');
}

export interface VerifyResult {
  ok: boolean;
  /** Always present so callers can log. */
  computed: string;
  expected: string;
}

/** Recompute and compare against an expected hex digest. */
export function verifySkillSha256(skillDir: string, expected: string, opts: ComputeOptions = {}): VerifyResult {
  const computed = computeSkillSha256(skillDir, opts);
  return { ok: computed.toLowerCase() === expected.toLowerCase(), computed, expected };
}
