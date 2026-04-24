// `yome skill enable / disable <slug>` — toggle whether the agent
// runtime should load this installed skill.
//
// We persist state as a sentinel file `.yome-disabled` inside the skill's
// install directory. Rationale (vs a central registry.json):
//   - zero schema migration; uninstall just `rm -rf` the dir, taking the
//     sentinel with it.
//   - works for dev-linked skills too (the flag lives on the symlink
//     target's view but writing is naturally scoped per-skill).
//
// `isSkillDisabled()` is exported so the loader (Server side) can read
// the same flag once we wire the generated registry to honour it.

import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { installPathForSlug } from './paths.js';
import { refreshIndex } from './skillsIndex.js';

const DISABLED_MARKER = '.yome-disabled';

export interface ToggleResult {
  ok: boolean;
  slug: string;
  state?: 'enabled' | 'disabled';
  reason?: string;
}

function markerPath(slug: string): string | null {
  const dir = installPathForSlug(slug);
  if (!dir) return null;
  return join(dir, DISABLED_MARKER);
}

export function isSkillDisabled(slug: string): boolean {
  const m = markerPath(slug);
  if (!m) return false;
  return existsSync(m);
}

export function setSkillEnabled(slug: string, enabled: boolean): ToggleResult {
  const m = markerPath(slug);
  if (!m) return { ok: false, slug, reason: 'invalid slug shape (expected @owner/name)' };
  const dir = dirname(m);
  if (!existsSync(dir)) {
    return { ok: false, slug, reason: `skill not installed at ${dir}` };
  }
  if (enabled) {
    if (existsSync(m)) {
      try { unlinkSync(m); } catch (e) { return { ok: false, slug, reason: (e as Error).message }; }
    }
    try { refreshIndex(); } catch { /* best effort */ }
    return { ok: true, slug, state: 'enabled' };
  }
  // disabling: write a tiny marker (no schema needed inside)
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(m, `disabled at ${new Date().toISOString()}\n`, { mode: 0o644 });
  } catch (e) {
    return { ok: false, slug, reason: (e as Error).message };
  }
  try { refreshIndex(); } catch { /* best effort */ }
  return { ok: true, slug, state: 'disabled' };
}
