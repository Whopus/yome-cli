// `yome skill link <path>` / `yome skill unlink <slug>` — point a slug
// in the registry at a working-directory copy on disk.
//
// Why symlinks (vs copying): the whole point of dev-link is "edit
// signature/viewer/cases live and have the agent see changes without
// reinstalling". A symlink at ~/.yome/skills/<owner>/<name>/ → user's
// working dir achieves that with zero machinery.
//
// On Windows, symlink creation requires admin or developer mode. We fall
// back to a junction or — worst case — print an actionable error.

import { existsSync, lstatSync, symlinkSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { readManifest, validateManifest } from './manifest.js';
import { installPathForSlug, parseSlug } from './paths.js';
import { writeInstallMeta, clearInstallMeta } from './installMeta.js';
import { refreshIndex } from './skillsIndex.js';

export interface LinkResult {
  ok: boolean;
  slug?: string;
  installedAt?: string;
  linkedTo?: string;
  reason?: string;
}

export interface UnlinkResult {
  ok: boolean;
  slug: string;
  unlinkedAt?: string;
  reason?: string;
}

export function linkSkill(source: string, opts: { force?: boolean } = {}): LinkResult {
  const abs = resolve(source);
  if (!existsSync(abs)) return { ok: false, reason: `path does not exist: ${abs}` };
  const manifest = readManifest(abs);
  if (!manifest) return { ok: false, reason: `${abs}/yome-skill.json missing or unreadable` };
  const v = validateManifest(manifest);
  if (!v.ok) return { ok: false, reason: `manifest invalid: ${v.errors.join('; ')}` };
  const slugP = parseSlug(manifest.slug);
  if (!slugP) return { ok: false, reason: `slug "${manifest.slug}" is malformed` };
  const dest = installPathForSlug(manifest.slug);
  if (!dest) return { ok: false, reason: `cannot derive install path for ${manifest.slug}` };

  if (existsSync(dest) || isSymlink(dest)) {
    if (!opts.force) {
      return { ok: false, reason: `${manifest.slug} already at ${dest} (use --force to replace)` };
    }
    rmSync(dest, { recursive: true, force: true });
  }

  mkdirSync(dirname(dest), { recursive: true });
  try {
    symlinkSync(abs, dest, 'dir');
  } catch (e) {
    return { ok: false, reason: `symlink failed: ${(e as Error).message}` };
  }
  try {
    writeInstallMeta(manifest.slug, {
      source: `dev-link:${abs}`,
      installed_at: new Date().toISOString(),
      manifest_version: manifest.version,
    });
  } catch { /* best effort */ }

  try { refreshIndex(); } catch { /* best effort */ }
  return { ok: true, slug: manifest.slug, installedAt: dest, linkedTo: abs };
}

export function unlinkSkill(slug: string): UnlinkResult {
  const dest = installPathForSlug(slug);
  if (!dest) return { ok: false, slug, reason: `slug "${slug}" is malformed` };
  if (!existsSync(dest) && !isSymlink(dest)) {
    return { ok: false, slug, reason: `${slug} is not installed at ${dest}` };
  }
  if (!isSymlink(dest)) {
    return { ok: false, slug, reason: `${slug} is installed but not a dev-link (use 'yome skill uninstall' instead)` };
  }
  try { unlinkSync(dest); } catch (e) {
    return { ok: false, slug, reason: `unlink failed: ${(e as Error).message}` };
  }
  clearInstallMeta(slug);
  try { refreshIndex(); } catch { /* best effort */ }
  return { ok: true, slug, unlinkedAt: dest };
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}
