// cli/src/yomeSkills/installGithub.ts — install a skill from a GitHub repo.
//
// Phase 2 source forms (per spec 8.5 / 11.2):
//   yome skill install github:owner/repo
//   yome skill install github:owner/repo@v1.2.0           (tag/branch/sha)
//   yome skill install github:owner/repo#path/to/skill    (subdir within repo)
//   yome skill install https://github.com/owner/repo
//   yome skill install https://github.com/owner/repo/tree/<ref>/path/to/skill
//
// Strategy:
//   1. Parse source → { owner, repo, ref?, subPath? }
//   2. git clone --depth=1 [-b ref] <https-url> <tmp-dir>
//   3. cd into <tmp-dir>/<subPath?> and treat it as a local skill
//   4. Delegate to installFromLocal() — same manifest validation,
//      same install location, same overwrite/force semantics.
//
// We deliberately use plain `git clone` (no `gh`) because public skill repos
// don't require auth and we want install to work for anonymous users too.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installFromLocal, type InstallOptions, type InstallResult } from './install.js';
import { writeInstallMeta } from './installMeta.js';
import { readManifest } from './manifest.js';

const DEFAULT_HUB_BASE = 'https://yome.work';

function getHubBase(): string {
  return (process.env.YOME_HUB_BASE ?? DEFAULT_HUB_BASE).replace(/\/+$/, '');
}

/**
 * Best-effort hub lookup for a skill's expected sha256 fingerprint at
 * the given version, plus deprecation metadata. Returns null fields
 * when the hub doesn't know about this slug or the version (older
 * publish, hub unreachable, etc.) — the caller treats null sha as
 * "no verification possible, proceed" to keep installs working
 * offline / against legacy data.
 */
interface HubVersionLookup {
  tarball_sha256: string | null;
  deprecated: boolean;
  deprecation_reason: string | null;
  replaced_by_version: string | null;
}

async function fetchHubVersionMeta(slug: string, version: string): Promise<HubVersionLookup> {
  const empty: HubVersionLookup = {
    tarball_sha256: null,
    deprecated: false,
    deprecation_reason: null,
    replaced_by_version: null,
  };
  try {
    const url = `${getHubBase()}/api/hub/skills/${encodeURIComponent(slug)}?version=${encodeURIComponent(version)}`;
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return empty;
    const j = (await r.json()) as {
      ok?: boolean;
      version?: {
        tarball_sha256?: string | null;
        deprecated?: boolean;
        deprecation_reason?: string | null;
        replaced_by_version?: string | null;
      };
    };
    if (!j || j.ok !== true || !j.version) return empty;
    const sha = j.version.tarball_sha256 ?? null;
    return {
      tarball_sha256: sha && sha.length >= 32 ? sha : null,
      deprecated: !!j.version.deprecated,
      deprecation_reason: j.version.deprecation_reason ?? null,
      replaced_by_version: j.version.replaced_by_version ?? null,
    };
  } catch { return empty; }
}

export interface ParsedGithubSource {
  owner: string;
  repo: string;
  ref?: string;
  subPath?: string;
  /** The https clone URL we will hand to `git clone`. */
  cloneUrl: string;
}

const GITHUB_SHORT_RE = /^github:([^/]+)\/([^@#]+)(?:@([^#]+))?(?:#(.+))?$/i;
const GITHUB_HTTPS_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+))?)?\/?$/i;

export function parseGithubSource(source: string): ParsedGithubSource | null {
  const trimmed = source.trim();
  let owner: string | null = null;
  let repo: string | null = null;
  let ref: string | undefined;
  let subPath: string | undefined;

  const short = GITHUB_SHORT_RE.exec(trimmed);
  if (short) {
    [, owner, repo, ref, subPath] = short;
  } else {
    const long = GITHUB_HTTPS_RE.exec(trimmed);
    if (long) {
      [, owner, repo, ref, subPath] = long;
    }
  }
  if (!owner || !repo) return null;
  return {
    owner,
    repo,
    ref: ref || undefined,
    subPath: subPath ? subPath.replace(/^\/+|\/+$/g, '') : undefined,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

export function isGithubSource(source: string): boolean {
  return /^github:/i.test(source) || /^https?:\/\/github\.com\//i.test(source);
}

interface CloneOk { ok: true; cloneDir: string }
interface CloneErr { ok: false; reason: string }

function shallowClone(parsed: ParsedGithubSource, verbose: boolean): CloneOk | CloneErr {
  const root = mkdtempSync(join(tmpdir(), 'yome-skill-clone-'));
  const cloneDir = join(root, parsed.repo);

  const args = ['clone', '--depth=1'];
  if (parsed.ref) args.push('-b', parsed.ref);
  args.push(parsed.cloneUrl, cloneDir);

  if (verbose) console.log(`$ git ${args.join(' ')}`);
  const r = spawnSync('git', args, { encoding: 'utf-8' });
  if (verbose && r.stdout) console.log(r.stdout.trimEnd());
  if (verbose && r.stderr) console.error(r.stderr.trimEnd());
  if (r.status !== 0) {
    rmSync(root, { recursive: true, force: true });
    const detail = r.stderr?.trim() || `git exited with status ${r.status ?? 'unknown'}`;
    return { ok: false, reason: `git clone failed: ${detail}` };
  }
  return { ok: true, cloneDir };
}

interface GithubInstallExtra {
  /** When set, after install we recompute sha256 of the install dir and
   *  compare against this value. Mismatch → uninstall + error.
   *  When omitted (e.g. older publish without sha256), verification is skipped. */
  expectedSha256?: string | null;
  /** Disable post-install sha256 verification entirely (dev/debug). */
  skipVerify?: boolean;
  /**
   * Install a deprecated version on purpose. Without this flag, the cli
   * refuses with a pointer to `replaced_by_version`. Default false so
   * users get a loud signal when they're about to install something the
   * author marked as superseded.
   */
  allowDeprecated?: boolean;
}

/**
 * Clone the repo into a tmp dir, then delegate to `installFromLocal`. Always
 * cleans up the tmp clone, even on failure. If `expectedSha256` is provided,
 * we verify the installed bytes match before declaring success.
 */
export async function installFromGithub(source: string, opts: InstallOptions & GithubInstallExtra = {}): Promise<InstallResult> {
  const parsed = parseGithubSource(source);
  if (!parsed) {
    return { ok: false, reason: `not a GitHub source: ${source}` };
  }

  // git availability check — `git --version` should always succeed if installed.
  const probe = spawnSync('git', ['--version'], { encoding: 'utf-8' });
  if (probe.status !== 0) {
    return { ok: false, reason: 'git is not installed or not in PATH' };
  }

  const cloned = shallowClone(parsed, !!opts.verbose);
  if (!cloned.ok) return cloned;

  let cleanupRoot = resolve(cloned.cloneDir, '..');
  try {
    const skillDir = parsed.subPath ? join(cloned.cloneDir, parsed.subPath) : cloned.cloneDir;
    if (!existsSync(skillDir)) {
      return { ok: false, reason: `subpath "${parsed.subPath}" does not exist in ${parsed.owner}/${parsed.repo}` };
    }
    if (!existsSync(join(skillDir, 'yome-skill.json'))) {
      return { ok: false, reason: `${parsed.owner}/${parsed.repo}${parsed.subPath ? `/${parsed.subPath}` : ''} has no yome-skill.json` };
    }
    // Hub lookup: fetch sha256 fingerprint AND deprecation status in
    // one shot, since we're already paying the round-trip cost. Best-
    // effort — hub unreachable / no record → empty meta and the install
    // proceeds without verification (back-compat with offline / legacy
    // versions).
    const cloneManifest = readManifest(skillDir);
    if (cloneManifest) {
      const meta = await fetchHubVersionMeta(cloneManifest.slug, cloneManifest.version);
      if (meta.deprecated && !opts.allowDeprecated) {
        const replaced = meta.replaced_by_version
          ? ` Use --version ${meta.replaced_by_version} instead, or pass --allow-deprecated to override.`
          : ' Pass --allow-deprecated to install it anyway.';
        const why = meta.deprecation_reason ? ` Reason: ${meta.deprecation_reason}.` : '';
        return {
          ok: false,
          reason:
            `${cloneManifest.slug}@${cloneManifest.version} is deprecated.${why}${replaced}`,
        };
      }
      if (meta.deprecated && opts.allowDeprecated) {
        const why = meta.deprecation_reason ? ` (${meta.deprecation_reason})` : '';
        console.warn(
          `! installing deprecated ${cloneManifest.slug}@${cloneManifest.version}${why}`,
        );
      }
      if (!opts.skipVerify && !opts.expectedSha256) {
        opts.expectedSha256 = meta.tarball_sha256;
      }
    }
    const result = await installFromLocal(skillDir, opts);
    if (result.ok && result.slug) {
      // installFromLocal stamped the meta with `local:<tmp clone path>`; rewrite
      // it to the github: shorthand so `yome skill update` knows what to refetch.
      try {
        writeInstallMeta(result.slug, {
          source: githubSourceToShorthand(parsed),
          installed_at: new Date().toISOString(),
          manifest_version: result.slug ? '' : '',
        });
        // Keep the version field accurate by reading the manifest at dest.
        const m = readManifest(result.installedAt!);
        if (m) {
          writeInstallMeta(result.slug, {
            source: githubSourceToShorthand(parsed),
            installed_at: new Date().toISOString(),
            manifest_version: m.version,
          });
        }
      } catch { /* best effort */ }

      // Post-install sha256 verification. If the hub had no fingerprint
      // for this version (older publish), expectedSha256 is null/undefined
      // and we skip — the install proceeds. If it doesn't match, we
      // tear down the install dir to leave the system in a clean state.
      if (!opts.skipVerify && opts.expectedSha256 && result.installedAt) {
        const { verifySkillSha256 } = await import('./integrity.js');
        const v = verifySkillSha256(result.installedAt, opts.expectedSha256);
        if (!v.ok) {
          rmSync(result.installedAt, { recursive: true, force: true });
          return {
            ok: false,
            reason: `sha256 mismatch — refusing install. expected ${v.expected.slice(0, 12)}…, got ${v.computed.slice(0, 12)}…`,
          };
        }
      }
    }
    return result;
  } finally {
    rmSync(cleanupRoot, { recursive: true, force: true });
  }
}

function githubSourceToShorthand(p: { owner: string; repo: string; ref?: string; subPath?: string }): string {
  let s = `github:${p.owner}/${p.repo}`;
  if (p.ref) s += `@${p.ref}`;
  if (p.subPath) s += `#${p.subPath}`;
  return s;
}
