// `yome skill publish` — notify the hub about a new version of a skill
// you maintain. Path A only (no tarball upload yet, no esbuild bundle).
//
// Pre-conditions:
//   - cwd contains a valid yome-skill.json
//   - cwd is a git repo with a github.com remote
//   - working tree is clean (no uncommitted changes)
//   - you are logged in (`yome login`) — we send the auth token to hub
//
// On success the hub upserts hub_skills (slug → repo) and inserts a
// hub_skill_versions row at manifest.version. The hub end of this is
// /api/hub/skills/<slug>/publish.

import { existsSync, statSync } from 'fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'path';
import { readManifest, validateManifest, type SkillManifest } from './manifest.js';
import { readAuthState } from './auth.js';
import { computeSkillSha256 } from './integrity.js';

export interface PublishOptions {
  /** Override hub base URL (default = YOME_HUB_BASE or https://yome.work). */
  hubBase?: string;
  /** Skip clean-tree + git remote checks (use --force). */
  force?: boolean;
  /** Test seam — replaces global fetch. */
  fetcher?: typeof fetch;
}

export interface PublishResult {
  ok: boolean;
  slug?: string;
  version?: string;
  hubResponse?: unknown;
  reason?: string;
}

const DEFAULT_HUB_BASE = 'https://yome.work';

export async function publishSkill(cwd: string, opts: PublishOptions = {}): Promise<PublishResult> {
  const abs = resolve(cwd);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    return { ok: false, reason: `cwd is not a directory: ${abs}` };
  }
  const manifest = readManifest(abs);
  if (!manifest) return { ok: false, reason: `${abs}/yome-skill.json missing or unreadable` };
  const v = validateManifest(manifest);
  if (!v.ok) return { ok: false, reason: `manifest invalid: ${v.errors.join('; ')}` };

  const auth = readAuthState();
  if (!auth) return { ok: false, reason: 'not logged in — run `yome login` first' };

  const gitInfo = inspectGit(abs);
  if (!gitInfo.ok && !opts.force) return { ok: false, reason: gitInfo.reason };

  const hubBase = (opts.hubBase ?? process.env.YOME_HUB_BASE ?? DEFAULT_HUB_BASE).replace(/\/$/, '');
  const url = `${hubBase}/api/hub/skills/${encodeURIComponent(manifest.slug)}/publish`;
  const body = buildPublishBody(manifest, gitInfo, abs);

  const fetcher = opts.fetcher ?? fetch;
  let resp;
  try {
    resp = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.yome_token}`,
        'User-Agent': 'yome-cli/0.1',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, reason: `publish request failed: ${(e as Error).message}` };
  }
  let parsed: unknown;
  try { parsed = await resp.json(); } catch { parsed = null; }
  if (!resp.ok) {
    const reason = parsed && typeof parsed === 'object' && 'error' in parsed
      ? String((parsed as { error: unknown }).error) : `HTTP ${resp.status}`;
    return { ok: false, reason: `hub rejected publish: ${reason}` };
  }
  return { ok: true, slug: manifest.slug, version: manifest.version, hubResponse: parsed };
}

interface GitInspect {
  ok: boolean;
  reason?: string;
  remote?: string;
  fullName?: string;
  branch?: string;
  sha?: string;
  isClean?: boolean;
}

function inspectGit(cwd: string): GitInspect {
  const probe = spawnSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf-8' });
  if (probe.status !== 0) return { ok: false, reason: 'cwd is not a git repo' };

  const remoteRes = spawnSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], { encoding: 'utf-8' });
  if (remoteRes.status !== 0) return { ok: false, reason: 'no remote.origin.url configured' };
  const remote = remoteRes.stdout.trim();
  const fullName = parseGithubFullName(remote);
  if (!fullName) return { ok: false, reason: `origin remote is not GitHub: ${remote}` };

  const branchRes = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' });
  const branch = branchRes.status === 0 ? branchRes.stdout.trim() : 'main';

  const shaRes = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf-8' });
  const sha = shaRes.status === 0 ? shaRes.stdout.trim() : '';

  const dirtyRes = spawnSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf-8' });
  const isClean = dirtyRes.status === 0 && dirtyRes.stdout.trim().length === 0;
  if (!isClean) return { ok: false, reason: 'working tree is dirty (commit or stash before publishing, or use --force)', remote, fullName, branch, sha, isClean };

  return { ok: true, remote, fullName, branch, sha, isClean };
}

function parseGithubFullName(s: string): string | null {
  const m = s.match(/github\.com[\/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/|$)/);
  return m ? m[1] : null;
}

interface PublishBody {
  slug: string;
  version: string;
  domain: string;
  name: string | null;
  description: string | null;
  capabilities: string[] | null;
  github_full_name: string | null;
  github_default_branch: string;
  git_sha: string | null;
  /** sha256 of the skill bytes (see integrity.ts). Hex, 64 chars. */
  tarball_sha256: string;
}

function buildPublishBody(m: SkillManifest, g: GitInspect, cwd: string): PublishBody {
  return {
    slug: m.slug,
    version: m.version,
    domain: m.domain,
    name: m.name ?? null,
    description: m.description ?? null,
    capabilities: m.capabilities ?? null,
    github_full_name: g.fullName ?? null,
    github_default_branch: g.branch ?? 'main',
    git_sha: g.sha ?? null,
    tarball_sha256: computeSkillSha256(cwd),
  };
}
