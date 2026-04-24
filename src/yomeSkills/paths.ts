// Path conventions for the yome-skill.json system (spec 4 / spec 8.5).
//
// We reuse ~/.yome/skills/ — the same directory the legacy markdown
// SKILL.md system already uses — and disambiguate by manifest file:
//   <yomeSkillsRoot>/<owner>/<name>/yome-skill.json   ← spec-style (this module)
//   <yomeSkillsRoot>/<some-folder>/SKILL.md            ← legacy markdown skill
// Both can coexist; loaders ignore directories without their expected manifest.

import { homedir } from 'os';
import { join } from 'path';

/** ~/.yome/skills */
export function getYomeSkillsRoot(): string {
  return join(homedir(), '.yome', 'skills');
}

/**
 * Parse @<owner>/<name> into install path components. Returns null if the
 * slug shape is wrong; callers should treat that as a CLI argument error.
 */
export function parseSlug(slug: string): { owner: string; name: string; full: string } | null {
  const m = /^@([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(slug);
  if (!m) return null;
  const owner = m[1];
  const name = m[2];
  return { owner, name, full: `@${owner}/${name}` };
}

/** Installed location for a given slug: ~/.yome/skills/<owner>/<name>/ */
export function installPathForSlug(slug: string): string | null {
  const p = parseSlug(slug);
  if (!p) return null;
  return join(getYomeSkillsRoot(), p.owner, p.name);
}
