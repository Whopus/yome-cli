// `yome skill install <source>` — install a skill into ~/.yome/skills/.
//
// During Phase 1 (per spec 8.5) we support local-path installs only:
//   yome skill install ./skills/yome-skill-ppt
//   yome skill install /abs/path/to/yome-skill-foo
// Phase 2 will add registry / git installs:
//   yome skill install @yome/ppt           (registry resolution)
//   yome skill install github:owner/repo   (git clone)
//
// Install strategy:
//   - Read source/yome-skill.json, validate slug+domain+version
//   - Compute install path ~/.yome/skills/<owner>/<name>/
//   - If already installed and not --force, error out
//   - Recursively copy source → install path (skip node_modules / .git / dist)
//   - Done; no post-install hooks in this phase

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { readManifest, validateManifest } from './manifest.js';
import { installPathForSlug, parseSlug } from './paths.js';
import { writeInstallMeta } from './installMeta.js';
import { decideCapabilities, writeAllowedCapabilities } from './capabilities.js';
import { refreshIndex } from './skillsIndex.js';
import { pingBlacklist } from './blacklist.js';

export interface InstallOptions {
  /** Overwrite an existing install of the same slug. */
  force?: boolean;
  /** Print verbose progress. */
  verbose?: boolean;
  /** Skip the capability prompt — auto-grant everything declared. CI / scripted use. */
  yes?: boolean;
  /** Skip blacklist check (NEVER do this in production). Default false. */
  skipBlacklist?: boolean;
}

export interface InstallResult {
  ok: boolean;
  slug?: string;
  installedAt?: string;
  copiedFiles?: number;
  reason?: string;
}

const IGNORE = new Set(['node_modules', '.git', 'dist', '.DS_Store', '.next', '.turbo', 'coverage']);

function copyDir(src: string, dest: string, log?: (s: string) => void): number {
  let count = 0;
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (IGNORE.has(entry)) continue;
    const s = join(src, entry);
    const d = join(dest, entry);
    const st = statSync(s);
    if (st.isDirectory()) {
      count += copyDir(s, d, log);
    } else if (st.isFile()) {
      copyFileSync(s, d);
      log?.(`  + ${entry}`);
      count++;
    }
  }
  return count;
}

export async function installFromLocal(source: string, opts: InstallOptions = {}): Promise<InstallResult> {
  const abs = resolve(source);
  if (!existsSync(abs)) return { ok: false, reason: `source path does not exist: ${abs}` };
  if (!statSync(abs).isDirectory()) return { ok: false, reason: `source is not a directory: ${abs}` };

  const manifest = readManifest(abs);
  if (!manifest) return { ok: false, reason: `${abs}/yome-skill.json missing or unreadable` };

  const v = validateManifest(manifest);
  if (!v.ok) return { ok: false, reason: `manifest invalid: ${v.errors.join('; ')}` };

  const slugParts = parseSlug(manifest.slug);
  if (!slugParts) return { ok: false, reason: `slug "${manifest.slug}" is malformed` };
  const dest = installPathForSlug(manifest.slug);
  if (!dest) return { ok: false, reason: `cannot derive install path for ${manifest.slug}` };

  // Blacklist gate — done before we touch the filesystem.
  if (!opts.skipBlacklist) {
    try {
      const hit = await pingBlacklist(manifest.slug);
      if (hit) {
        return {
          ok: false,
          reason: `${manifest.slug} is on the yome.work blacklist (${hit.reason})${hit.detail ? `: ${hit.detail}` : ''}`,
        };
      }
    } catch { /* offline → ignore, conservative no-block */ }
  }

  // Capability prompt — done before we touch the filesystem so a
  // declined install leaves no trace.
  const decision = await decideCapabilities(manifest.slug, manifest.system_capabilities, { assumeYes: opts.yes });
  if (!decision.ok) {
    return { ok: false, reason: decision.reason ?? 'capability grant declined' };
  }

  if (existsSync(dest)) {
    if (!opts.force) {
      return { ok: false, reason: `${manifest.slug} already installed at ${dest} (use --force to overwrite)` };
    }
    // Move the existing install aside as the rollback snapshot. We keep
    // exactly ONE previous version (per spec 11.4-D "保留最近 2 个版本").
    // The snapshot lives next to the install dir so it shares the slug's
    // capability grant / parent directory layout.
    try {
      const snap = `${dest}.previous`;
      if (existsSync(snap)) rmSync(snap, { recursive: true, force: true });
      // os.rename is atomic; if it fails (cross-filesystem etc) we fall
      // back to copy-then-delete via a recursive helper inlined below.
      try {
        renameSync(dest, snap);
      } catch {
        copyDir(dest, snap);
        rmSync(dest, { recursive: true, force: true });
      }
    } catch {
      // If snapshotting fails for any reason we still proceed — losing
      // rollback ability is better than losing the install itself.
      try { rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  const log = opts.verbose ? (s: string) => process.stdout.write(s + '\n') : undefined;
  const copied = copyDir(abs, dest, log);

  // Persist how we got here so `yome skill update` can replay later.
  try {
    writeInstallMeta(manifest.slug, {
      source: `local:${abs}`,
      installed_at: new Date().toISOString(),
      manifest_version: manifest.version,
    });
  } catch { /* best effort */ }

  // Write the capability grant alongside the install meta.
  try {
    if (decision.granted) writeAllowedCapabilities(manifest.slug, decision.granted);
  } catch { /* best effort */ }

  // Refresh the fast lookup index.
  try { refreshIndex(); } catch { /* best effort */ }

  return {
    ok: true,
    slug: manifest.slug,
    installedAt: dest,
    copiedFiles: copied,
  };
}
