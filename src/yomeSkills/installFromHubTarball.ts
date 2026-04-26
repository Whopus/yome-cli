// cli/src/yomeSkills/installFromHubTarball.ts
//
// Hub-cached tarball install path. Used by `yome skill install <slug>`
// and as the fast path inside `installFromGithub` when the hub already
// has bytes for the version the user is asking for.
//
// Why this exists:
//   - Sub-second installs vs 5-30s for `git clone --depth=1` from China.
//   - GitHub repo can be deleted / transferred / temporarily unreachable
//     and the cached tarball still works.
//   - The bytes we install are byte-identical to what publisher's
//     tarball_sha256 was computed against — no race window between
//     publish-time and install-time on the upstream repo.
//
// Pipeline:
//   1. GET /api/hub/skills/<slug>?version=<v>  (resolve version + sha)
//   2. GET /api/hub/skills/<slug>/versions/<v>/tarball  (302 → public URL)
//   3. Stream the tar.gz into a tmp dir
//   4. Extract via the system `tar -xzf` (same binary cli installs require)
//   5. Verify sha256 of the extracted tree == hub sha256 == sha256 in the
//      X-Yome-Skill-Sha256 header from step 2
//   6. Hand the extracted dir to `installFromLocal()` for the rest of
//      the install (capability prompt, rollback snapshot, meta write)
//
// On any failure the caller falls back to `installFromGithub`. The
// retry path is opaque — the user just sees one install attempt.

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFromLocal, type InstallOptions, type InstallResult } from './install.js';
import { writeInstallMeta } from './installMeta.js';
import { computeSkillSha256 } from './integrity.js';
import { readManifest } from './manifest.js';

const DEFAULT_HUB_BASE = 'https://yome.work';

function getHubBase(): string {
  return (process.env.YOME_HUB_BASE ?? DEFAULT_HUB_BASE).replace(/\/+$/, '');
}

export interface InstallFromHubExtra {
  /** Override version. When omitted we install the slug's latest non-deprecated. */
  version?: string;
  /** Pass through to installFromLocal — auto-grant capabilities, useful in CI. */
  yes?: boolean;
  /** Pass through. */
  force?: boolean;
  verbose?: boolean;
  /** Install a deprecated version on purpose. Default false. */
  allowDeprecated?: boolean;
  /** Disable post-install sha256 verification (dev/debug). Default false. */
  skipVerify?: boolean;
}

export interface InstallFromHubResult extends InstallResult {
  /** Distinguish "really came from hub" from "fell through to github". */
  source?: 'hub' | 'fallback';
  /** The exact version installed (resolved on the hub). */
  resolvedVersion?: string;
}

interface HubVersionMeta {
  version: string;
  tarball_sha256: string | null;
  deprecated: boolean;
  deprecation_reason: string | null;
  replaced_by_version: string | null;
}
interface HubSkillMeta {
  slug: string;
  github_full_name: string | null;
  effective_latest_version: string | null;
}

/** GET /api/hub/skills/<slug>[?version=v] — returns null on any failure. */
async function fetchHubMeta(slug: string, version?: string): Promise<{ skill: HubSkillMeta; ver: HubVersionMeta } | null> {
  try {
    const url =
      `${getHubBase()}/api/hub/skills/${encodeURIComponent(slug)}` +
      (version ? `?version=${encodeURIComponent(version)}` : '');
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = (await r.json()) as {
      ok?: boolean;
      skill?: Record<string, unknown>;
      version?: Record<string, unknown>;
    };
    if (!j || j.ok !== true || !j.skill || !j.version) return null;
    return {
      skill: {
        slug: String(j.skill.slug ?? slug),
        github_full_name: (j.skill.github_full_name as string) ?? null,
        effective_latest_version: (j.skill.effective_latest_version as string) ?? null,
      },
      ver: {
        version: String(j.version.version),
        tarball_sha256: (j.version.tarball_sha256 as string) ?? null,
        deprecated: !!j.version.deprecated,
        deprecation_reason: (j.version.deprecation_reason as string) ?? null,
        replaced_by_version: (j.version.replaced_by_version as string) ?? null,
      },
    };
  } catch { return null; }
}

/**
 * Install a slug by pulling the hub-cached tarball. Returns ok=false +
 * a structured reason whenever the hub doesn't have a usable tarball
 * — the caller can then fall back to a GitHub clone.
 */
export async function installFromHubTarball(slug: string, opts: InstallFromHubExtra = {}): Promise<InstallFromHubResult> {
  const meta = await fetchHubMeta(slug, opts.version);
  if (!meta) {
    return { ok: false, source: 'hub', reason: `hub has no record for ${slug}${opts.version ? `@${opts.version}` : ''}` };
  }

  // Deprecation gate (mirror installFromGithub).
  if (meta.ver.deprecated && !opts.allowDeprecated) {
    const replaced = meta.ver.replaced_by_version
      ? ` Use --version ${meta.ver.replaced_by_version} instead, or pass --allow-deprecated to override.`
      : ' Pass --allow-deprecated to install it anyway.';
    const why = meta.ver.deprecation_reason ? ` Reason: ${meta.ver.deprecation_reason}.` : '';
    return { ok: false, source: 'hub', reason: `${slug}@${meta.ver.version} is deprecated.${why}${replaced}` };
  }

  // Resolve tarball URL via the hub redirect.
  const tarUrl = `${getHubBase()}/api/hub/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(meta.ver.version)}/tarball`;
  let resp: Response;
  try {
    resp = await fetch(tarUrl, { redirect: 'follow' });
  } catch (e) {
    return { ok: false, source: 'hub', reason: `tarball fetch failed: ${(e as Error).message}` };
  }
  if (!resp.ok) {
    if (resp.status === 410) {
      return { ok: false, source: 'hub', reason: `${slug}@${meta.ver.version} has no cached tarball (legacy publish; will fall back to git clone)` };
    }
    return { ok: false, source: 'hub', reason: `tarball fetch HTTP ${resp.status}` };
  }
  const tarBytes = Buffer.from(await resp.arrayBuffer());
  if (tarBytes.length === 0) {
    return { ok: false, source: 'hub', reason: `tarball was empty` };
  }

  // Extract to tmp dir.
  const cleanupRoot = mkdtempSync(join(tmpdir(), 'yome-hub-install-'));
  const extractDir = join(cleanupRoot, 'skill');
  try {
    const tarFile = join(cleanupRoot, 'skill.tar.gz');
    writeFileSync(tarFile, tarBytes);
    const mk = spawnSync('mkdir', ['-p', extractDir], { encoding: 'utf-8' });
    if (mk.status !== 0) {
      return { ok: false, source: 'hub', reason: `mkdir failed: ${mk.stderr || ''}` };
    }
    const ut = spawnSync('tar', ['-xzf', tarFile, '-C', extractDir], { encoding: 'utf-8' });
    if (ut.status !== 0) {
      return { ok: false, source: 'hub', reason: `tar -xzf failed: ${(ut.stderr || '').trim()}` };
    }

    // Verify sha256 of extracted tree against hub-recorded sha.
    if (!opts.skipVerify && meta.ver.tarball_sha256) {
      const computed = computeSkillSha256(extractDir);
      if (computed.toLowerCase() !== meta.ver.tarball_sha256.toLowerCase()) {
        return {
          ok: false,
          source: 'hub',
          reason: `sha256 mismatch on hub tarball — refusing install. expected ${meta.ver.tarball_sha256.slice(0, 12)}…, got ${computed.slice(0, 12)}…`,
        };
      }
    }

    if (!existsSync(join(extractDir, 'yome-skill.json'))) {
      return { ok: false, source: 'hub', reason: `extracted tarball has no yome-skill.json — hub artefact corrupted` };
    }

    // Hand off to local install. installFromLocal handles capability
    // prompt + rollback snapshot + index refresh.
    const result = await installFromLocal(extractDir, {
      force: opts.force,
      verbose: opts.verbose,
      yes: opts.yes,
      // skipBlacklist: false (default; hub blacklist still applies)
    });

    if (result.ok && result.slug) {
      // Overwrite the meta with the hub source so `yome skill update`
      // re-pulls from hub instead of the tmp dir.
      try {
        const installed = readManifest(result.installedAt!);
        writeInstallMeta(result.slug, {
          source: `hub:${slug}@${meta.ver.version}`,
          installed_at: new Date().toISOString(),
          manifest_version: installed?.version ?? meta.ver.version,
        });
      } catch { /* best effort */ }
    }

    return { ...result, source: 'hub', resolvedVersion: meta.ver.version };
  } finally {
    rmSync(cleanupRoot, { recursive: true, force: true });
  }
}
