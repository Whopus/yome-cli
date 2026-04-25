// `yome skill list` — enumerate installed yome-skill.json skills under
// ~/.yome/skills/<owner>/<name>/. Skills using the legacy SKILL.md
// markdown format are silently ignored (different system, see existing
// cli/src/skills/loader.ts).

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { readManifest, type SkillManifest } from './manifest.js';
import { getYomeSkillsRoot } from './paths.js';

export interface InstalledEntry {
  slug: string;
  domain: string;
  version: string;
  name?: string;
  description?: string;
  installedAt: string;
  manifest: SkillManifest;
}

function listChildDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((n) => {
      // Skip rollback snapshots — install.ts moves the previous version
      // sideways to <slug>.previous before overwriting. They have a valid
      // yome-skill.json so they'd otherwise look like a duplicate install.
      if (n.endsWith('.previous')) return false;
      try { return statSync(join(dir, n)).isDirectory(); } catch { return false; }
    });
  } catch {
    return [];
  }
}

export function listInstalled(): InstalledEntry[] {
  const root = getYomeSkillsRoot();
  const out: InstalledEntry[] = [];

  for (const owner of listChildDirs(root)) {
    const ownerDir = join(root, owner);
    for (const name of listChildDirs(ownerDir)) {
      const skillDir = join(ownerDir, name);
      const manifest = readManifest(skillDir);
      if (!manifest) continue;
      out.push({
        slug: manifest.slug,
        domain: manifest.domain,
        version: manifest.version,
        name: manifest.name,
        description: manifest.description,
        installedAt: skillDir,
        manifest,
      });
    }
  }

  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}
