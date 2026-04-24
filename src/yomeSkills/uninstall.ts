// `yome skill uninstall <slug>` — remove a previously installed skill.

import { existsSync, rmSync } from 'fs';
import { installPathForSlug, parseSlug } from './paths.js';
import { refreshIndex } from './skillsIndex.js';

export interface UninstallResult {
  ok: boolean;
  slug?: string;
  removedFrom?: string;
  reason?: string;
}

export function uninstallBySlug(slug: string): UninstallResult {
  const parts = parseSlug(slug);
  if (!parts) return { ok: false, reason: `bad slug "${slug}" (expected @<owner>/<name>)` };

  const dir = installPathForSlug(slug);
  if (!dir) return { ok: false, reason: `cannot derive install path for ${slug}` };

  if (!existsSync(dir)) {
    return { ok: false, reason: `${slug} not installed at ${dir}` };
  }

  rmSync(dir, { recursive: true, force: true });
  try { refreshIndex(); } catch { /* best effort */ }
  return { ok: true, slug: parts.full, removedFrom: dir };
}
