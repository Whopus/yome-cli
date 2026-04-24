// `yome skill rollback <slug>` — swap back to the previous version.
//
// Spec 11.4-D requires "保留最近 2 个版本目录" — we keep one snapshot
// (`<slug-dir>.previous/`) created by `install.ts` whenever it overwrites
// an existing install. This module performs the atomic swap:
//
//   live  : ~/.yome/skills/<owner>/<name>            (current)
//   prev  : ~/.yome/skills/<owner>/<name>.previous   (last good)
//
// rollback:
//   prev  → swap-tmp → live   (i.e. live becomes previous, previous becomes live)
//
// After rollback the swap-tmp now holds what was live; we move it to the
// `.previous` slot so the user can also rollback the rollback (one level
// of undo, capped to keep disk usage bounded).
//
// Edge cases:
//   - No `.previous` snapshot present → tell the user, exit cleanly.
//   - Live install was uninstalled (no live dir) → restore previous in place.
//   - Allowed-capabilities sidecar lives INSIDE the install dir, so it
//     swaps with the rest. No extra work needed.
//   - Index cache may now be stale → we refresh it.

import { existsSync, renameSync, rmSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { installPathForSlug } from './paths.js';
import { readManifest } from './manifest.js';
import { refreshIndex } from './skillsIndex.js';

export interface RollbackResult {
  ok: boolean;
  slug?: string;
  /** Version we rolled back TO (read from the restored manifest). */
  restoredVersion?: string;
  /** Version we rolled back FROM. */
  previousVersion?: string;
  reason?: string;
}

export async function rollbackBySlug(slug: string): Promise<RollbackResult> {
  const live = installPathForSlug(slug);
  if (!live) return { ok: false, reason: `bad slug: ${slug}` };

  const snap = `${live}.previous`;
  if (!existsSync(snap)) {
    return { ok: false, reason: `no rollback snapshot for ${slug} — nothing to roll back to` };
  }

  // Capture versions for the report (best-effort; manifest read is cheap).
  const liveManifest = existsSync(live) ? readManifest(live) : null;
  const prevManifest = readManifest(snap);
  const previousVersion = liveManifest?.version;
  const restoredVersion = prevManifest?.version;

  // Atomic-ish swap. We need a temporary intermediate name because
  // renameSync(live, snap) when snap already exists is destructive on POSIX.
  // Sequence:
  //   1. live  → tmp
  //   2. snap  → live
  //   3. tmp   → snap   (overwrite-protected: we rmSync first if it exists,
  //                       though step 2 just moved it away)
  const tmp = `${live}.swap-${process.pid}-${Date.now()}`;
  try {
    if (existsSync(live)) {
      mkdirSync(dirname(live), { recursive: true });
      renameSync(live, tmp);
    }
    renameSync(snap, live);
    if (existsSync(tmp)) {
      // step 3: archive what was live as the new previous
      if (existsSync(snap)) rmSync(snap, { recursive: true, force: true });
      renameSync(tmp, snap);
    }
  } catch (err) {
    // Best-effort recovery: try to put live back if we moved it but failed
    // to install snap. Don't pretend everything is fine.
    try { if (existsSync(tmp) && !existsSync(live)) renameSync(tmp, live); } catch { /* ignore */ }
    return { ok: false, slug, reason: `rename failed during rollback: ${(err as Error).message}` };
  }

  try { refreshIndex(); } catch { /* best effort */ }

  return {
    ok: true,
    slug,
    restoredVersion,
    previousVersion,
  };
}
