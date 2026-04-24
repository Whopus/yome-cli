// `.install-meta.json` — small per-skill sidecar capturing how the skill
// was installed. Used by `yome skill update` (to know what to re-pull)
// and `yome skill list` (to render the source column).
//
// Schema (intentionally tiny so it's easy to bump):
//   {
//     "source": "github:owner/repo[@ref][#subpath]"
//             | "local:/abs/path"
//             | "dev-link:/abs/path"
//             | "hub:@owner/name"
//             | "url:<https url>",
//     "installed_at": "<ISO-8601>",
//     "manifest_version": "<from yome-skill.json at install time>"
//   }
//
// Missing file = legacy install (pre-meta); `update` treats it as
// "source unknown — please reinstall manually".

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync,
} from 'fs';
import { join, dirname } from 'path';
import { installPathForSlug } from './paths.js';

export interface InstallMeta {
  source: string;
  installed_at: string;
  manifest_version: string;
}

const META_FILENAME = '.install-meta.json';

function metaPath(slugOrDir: string): string {
  // Accept either a slug like @yome/ppt OR an absolute install dir.
  if (slugOrDir.startsWith('/') || slugOrDir.startsWith('.')) {
    return join(slugOrDir, META_FILENAME);
  }
  const dir = installPathForSlug(slugOrDir);
  if (!dir) throw new Error(`invalid slug: ${slugOrDir}`);
  return join(dir, META_FILENAME);
}

export function readInstallMeta(slugOrDir: string): InstallMeta | null {
  let f: string;
  try { f = metaPath(slugOrDir); } catch { return null; }
  if (!existsSync(f)) return null;
  try {
    const obj = JSON.parse(readFileSync(f, 'utf-8'));
    if (typeof obj?.source !== 'string') return null;
    return {
      source: String(obj.source),
      installed_at: String(obj.installed_at ?? ''),
      manifest_version: String(obj.manifest_version ?? ''),
    };
  } catch {
    return null;
  }
}

export function writeInstallMeta(slugOrDir: string, meta: InstallMeta): void {
  const f = metaPath(slugOrDir);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(meta, null, 2) + '\n');
}

export function clearInstallMeta(slugOrDir: string): void {
  let f: string;
  try { f = metaPath(slugOrDir); } catch { return; }
  if (existsSync(f)) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
}
