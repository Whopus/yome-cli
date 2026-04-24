// `yome skill doctor` — sanity-check the local registry.
//
// Detects:
//   - Skills present on disk but with broken / missing yome-skill.json
//   - Stale .index.json (entries that no longer have a backing dir)
//   - Capability grants for skills whose declared system_capabilities have
//     since shrunk (orphan grants — safe but noisy)
//   - Dev-link symlinks pointing at deleted source dirs
//   - Missing .install-meta.json (legacy; warn-only — can't update)
//
// Exit codes: 0 = no issues, 1 = at least one issue.
//
// `doctor` does NOT fix anything by itself — it just reports. The user
// follows up with `yome skill uninstall <slug>` or `yome skill install
// <source> --force` as appropriate.

import { existsSync, readdirSync, statSync, lstatSync, readlinkSync } from 'fs';
import { join } from 'path';
import { getYomeSkillsRoot } from './paths.js';
import { readManifest } from './manifest.js';
import { readInstallMeta } from './installMeta.js';
import {
  readAllowedCapabilities, normaliseDeclared, KNOWN_CAPABILITIES, type Capability,
} from './capabilities.js';
import { readIndex } from './skillsIndex.js';

interface DoctorIssue {
  level: 'error' | 'warning';
  slug?: string;
  path?: string;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  scanned: number;
  issues: DoctorIssue[];
}

function listInstallDirs(): { slug: string; dir: string; isLink: boolean; linkTarget?: string }[] {
  const root = getYomeSkillsRoot();
  if (!existsSync(root)) return [];
  const out: { slug: string; dir: string; isLink: boolean; linkTarget?: string }[] = [];
  for (const owner of readdirSync(root)) {
    if (owner.startsWith('.')) continue;
    const ownerPath = join(root, owner);
    if (!statSync(ownerPath).isDirectory()) continue;
    for (const name of readdirSync(ownerPath)) {
      if (name.startsWith('.')) continue;
      const dir = join(ownerPath, name);
      const lst = lstatSync(dir);
      const isLink = lst.isSymbolicLink();
      const linkTarget = isLink ? readlinkSync(dir) : undefined;
      // Only treat as a real install if it's a directory or a symlink to one.
      try {
        const target = isLink ? statSync(dir) : lst;
        if (!target.isDirectory()) continue;
      } catch {
        // Broken symlink — surface this as an issue below.
        out.push({ slug: `@${owner}/${name}`, dir, isLink: true, linkTarget });
        continue;
      }
      out.push({ slug: `@${owner}/${name}`, dir, isLink, linkTarget });
    }
  }
  return out;
}

export function runDoctor(): DoctorReport {
  const issues: DoctorIssue[] = [];
  const installs = listInstallDirs();
  const seenSlugs = new Set<string>();

  for (const it of installs) {
    seenSlugs.add(it.slug);

    // Broken symlink (dev-link target deleted)
    if (it.isLink) {
      try {
        statSync(it.dir);
      } catch {
        issues.push({
          level: 'error',
          slug: it.slug,
          path: it.dir,
          message: `dev-link points at deleted target ${it.linkTarget}`,
        });
        continue;
      }
    }

    // Manifest readable + slug consistent
    const m = readManifest(it.dir);
    if (!m) {
      issues.push({
        level: 'error',
        slug: it.slug,
        path: it.dir,
        message: 'yome-skill.json missing or unparseable',
      });
      continue;
    }
    if (m.slug !== it.slug) {
      issues.push({
        level: 'error',
        slug: it.slug,
        path: it.dir,
        message: `slug mismatch — directory says ${it.slug} but manifest says ${m.slug}`,
      });
    }

    // install-meta presence (legacy installs may lack it)
    if (!readInstallMeta(it.slug)) {
      issues.push({
        level: 'warning',
        slug: it.slug,
        message: '.install-meta.json missing — `yome skill update` will not know how to refresh this skill',
      });
    }

    // Capability grants vs current declared set
    const allowed = readAllowedCapabilities(it.slug);
    if (allowed) {
      const declared = new Set(normaliseDeclared(m.system_capabilities));
      const orphan = allowed.allowed.filter(c => !declared.has(c));
      if (orphan.length > 0) {
        issues.push({
          level: 'warning',
          slug: it.slug,
          message: `granted capabilities not declared in current manifest: ${orphan.join(', ')} — consider \`yome skill perms ${it.slug} --revoke=<cap>\``,
        });
      }
      // Also surface any grant for a cap we no longer recognise
      const unknown = allowed.allowed.filter(c => !KNOWN_CAPABILITIES.includes(c as Capability));
      if (unknown.length > 0) {
        issues.push({
          level: 'warning',
          slug: it.slug,
          message: `granted unknown capabilities: ${unknown.join(', ')} (CLI version mismatch?)`,
        });
      }
    }
  }

  // Index stale check
  const idx = readIndex();
  if (idx) {
    for (const entry of idx.skills) {
      if (!seenSlugs.has(entry.slug)) {
        issues.push({
          level: 'warning',
          slug: entry.slug,
          message: '.index.json lists this skill but no install dir was found — run `yome skill list` to refresh',
        });
      }
    }
  }

  return {
    ok: issues.filter(i => i.level === 'error').length === 0,
    scanned: installs.length,
    issues,
  };
}
