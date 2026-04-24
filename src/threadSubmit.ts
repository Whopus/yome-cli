// cli/src/threadSubmit.ts — push a redacted bundle as a PR to a skill's repo.
//
// Spec 9.1 step 5 (token-bound path). The "no GitHub token / hub-bot relay"
// path is deferred to Phase 3 once the hub backend exists.
//
// Pipeline (all done via the locally-installed `gh` CLI; we shell out and
// never import @octokit/rest, keeping the CLI install tiny):
//
//   1.  Resolve target repo from skill manifest (slug → installed manifest →
//       `repo` field, e.g. https://github.com/yome-official/yome-skill-ppt).
//   2.  `gh auth status` — fail fast with a clear message if not signed in.
//   3.  `gh repo fork <upstream> --clone --remote=false` into a tmp dir.
//   4.  `git checkout -b case/<slug>-<caseId>`
//   5.  Copy bundle/* → cases/<slugBase>/<caseId>/
//   6.  `git add -A && git commit -m "<title>"` (signed-off optional)
//   7.  `git push --set-upstream origin case/<slug>-<caseId>`
//   8.  `gh pr create --repo <upstream> --title "..." --body "..."`
//   9.  Return PR URL.
//
// We do NOT delete the tmp clone — leave it for the user to inspect / amend.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { readManifest, type SkillManifest } from './yomeSkills/manifest.js';
import { installPathForSlug, parseSlug } from './yomeSkills/paths.js';

export interface SubmitOptions {
  /** Path to a bundle directory produced by `yome thread share`. */
  bundleDir: string;
  /** Skill slug (e.g. "@yome/ppt") — used to discover repo from manifest. */
  skillSlug: string;
  /** Case id; will be the name of the cases/<slug>/<caseId>/ directory. */
  caseId?: string;
  /** Override commit/PR title. Default: "case: add <caseId> for <skillSlug>". */
  title?: string;
  /** Override PR body. Default: a generated summary referencing the bundle README. */
  body?: string;
  /**
   * If true, do everything **except** `git push` and `gh pr create` —
   * useful for local diagnostics.
   */
  dryRun?: boolean;
  /** Verbose: print every shelled command + its stdout. */
  verbose?: boolean;
}

export type SubmitResult =
  | {
      ok: true;
      prUrl?: string;          // undefined when dryRun
      branch: string;
      caseId: string;
      cloneDir: string;
      upstream: string;
    }
  | { ok: false; reason: string; cloneDir?: string };

/** Result of looking up a skill's upstream repo. */
interface UpstreamLookup {
  /** "owner/name" e.g. "yome-official/yome-skill-ppt" */
  fullName: string;
  /** Skill manifest (for downstream reference). */
  manifest: SkillManifest;
}

const REPO_URL_RE = /^https?:\/\/github\.com\/([^/]+\/[^/.\s]+?)(?:\.git)?\/?$/;

/**
 * Look up a skill's upstream GitHub repo from `~/.yome/skills/<owner>/<name>/`.
 * Falls back to the monorepo `skills/yome-skill-<domain>/` if not installed.
 */
function lookupUpstream(skillSlug: string): UpstreamLookup | { ok: false; reason: string } {
  // 1. Try installed location first
  const installPath = installPathForSlug(skillSlug);
  let manifest = installPath ? readManifest(installPath) : null;

  // 2. Fall back to monorepo
  if (!manifest) {
    const parsed = parseSlug(skillSlug);
    if (parsed) {
      const monorepoPath = resolve(process.cwd(), 'skills', `yome-skill-${parsed.name}`);
      if (existsSync(join(monorepoPath, 'yome-skill.json'))) {
        manifest = readManifest(monorepoPath);
      }
    }
  }

  if (!manifest) {
    return { ok: false, reason: `skill ${skillSlug} not found locally — install it first or run from monorepo root` };
  }
  if (!manifest.repo) {
    return { ok: false, reason: `skill ${skillSlug} manifest has no "repo" field — cannot determine upstream` };
  }
  const m = REPO_URL_RE.exec(manifest.repo.trim());
  if (!m) {
    return { ok: false, reason: `skill ${skillSlug} manifest "repo" is not a github.com URL: ${manifest.repo}` };
  }
  return { fullName: m[1], manifest };
}

/** Run a shell command, capturing stdout/stderr. Throws nothing — caller checks status. */
function run(cmd: string, args: string[], cwd: string | undefined, verbose: boolean): SpawnSyncReturns<string> {
  if (verbose) {
    const inDir = cwd ? ` (in ${cwd})` : '';
    // eslint-disable-next-line no-console
    console.log(`$ ${cmd} ${args.join(' ')}${inDir}`);
  }
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf-8', env: process.env });
  if (verbose && result.stdout) console.log(result.stdout.trimEnd());
  if (verbose && result.stderr) console.error(result.stderr.trimEnd());
  return result;
}

function ghIsInstalled(): boolean {
  const r = spawnSync('gh', ['--version'], { encoding: 'utf-8' });
  return r.status === 0;
}

function ghIsAuthed(verbose: boolean): { ok: boolean; reason?: string } {
  const r = run('gh', ['auth', 'status'], undefined, verbose);
  if (r.status === 0) return { ok: true };
  return { ok: false, reason: r.stderr?.trim() || 'gh auth status failed (run: gh auth login)' };
}

function copyBundleInto(srcDir: string, dest: string): number {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of readdirSync(srcDir)) {
    if (entry === '.git' || entry === 'node_modules' || entry === '.DS_Store') continue;
    const s = join(srcDir, entry);
    const d = join(dest, entry);
    const st = statSync(s);
    if (st.isDirectory()) {
      count += copyBundleInto(s, d);
    } else if (st.isFile()) {
      copyFileSync(s, d);
      count++;
    }
  }
  return count;
}

function defaultCaseId(bundleDir: string): string {
  // Bundles default to <sessionId>-<timestamp>; the basename is already unique.
  return basename(bundleDir).slice(0, 60);
}

function defaultTitle(skillSlug: string, caseId: string): string {
  return `case: add ${caseId} for ${skillSlug}`;
}

function defaultBody(skillSlug: string, caseId: string, bundleDir: string): string {
  let bundleReadme = '';
  try {
    bundleReadme = readFileSync(join(bundleDir, 'README.md'), 'utf-8');
  } catch {
    /* missing README is fine */
  }
  return `Adds a new replayable case for **${skillSlug}** under \`cases/${parseSlug(skillSlug)?.name ?? 'unknown'}/${caseId}/\`.

Submitted via \`yome thread share --submit\`. The bundle was redacted on-device using the default ThreadRedactor rules (email / phone / api-key / path / mind).

---

${bundleReadme}`;
}

export function submitBundle(opts: SubmitOptions): SubmitResult {
  if (!existsSync(opts.bundleDir)) {
    return { ok: false, reason: `bundle directory does not exist: ${opts.bundleDir}` };
  }
  if (!existsSync(join(opts.bundleDir, 'thread.json'))) {
    return { ok: false, reason: `${opts.bundleDir} is not a valid bundle (missing thread.json)` };
  }

  if (!ghIsInstalled()) {
    return { ok: false, reason: 'gh CLI is not installed (https://cli.github.com). Install it then run: gh auth login' };
  }
  const auth = ghIsAuthed(!!opts.verbose);
  if (!auth.ok) {
    return { ok: false, reason: `gh CLI not authenticated: ${auth.reason}\nRun: gh auth login\n\n(The token-less hub-bot relay path is planned for Phase 3 and not yet implemented.)` };
  }

  const upstreamLookup = lookupUpstream(opts.skillSlug);
  if ('ok' in upstreamLookup && upstreamLookup.ok === false) return upstreamLookup;
  const { fullName: upstream, manifest } = upstreamLookup as UpstreamLookup;

  const caseId = opts.caseId ?? defaultCaseId(opts.bundleDir);
  const branch = `case/${manifest.domain}-${caseId}`;
  const title = opts.title ?? defaultTitle(opts.skillSlug, caseId);
  const body = opts.body ?? defaultBody(opts.skillSlug, caseId, opts.bundleDir);

  // Clone into ~/.yome/shares/.work/<random>/<repo>
  const workRoot = join(homedir(), '.yome', 'shares', '.work');
  if (!existsSync(workRoot)) mkdirSync(workRoot, { recursive: true });
  const tmpDir = mkdtempSync(join(workRoot, 'submit-'));
  const cloneDir = join(tmpDir, basename(upstream));

  // 1. fork + clone. `gh repo fork ... --clone -- <git-clone-args>` lets us
  // pass `--depth` and the target directory through to git clone.
  const forkResult = run(
    'gh',
    ['repo', 'fork', upstream, '--clone', '--', '--depth=20', cloneDir],
    undefined,
    !!opts.verbose,
  );
  if (forkResult.status !== 0) {
    return { ok: false, reason: `gh repo fork failed: ${forkResult.stderr?.trim()}`, cloneDir };
  }

  // 2. checkout new branch
  const checkout = run('git', ['checkout', '-b', branch], cloneDir, !!opts.verbose);
  if (checkout.status !== 0) {
    return { ok: false, reason: `git checkout -b failed: ${checkout.stderr?.trim()}`, cloneDir };
  }

  // 3. copy bundle into cases/<domain>/<caseId>/
  const targetRel = join('cases', manifest.domain, caseId);
  const targetAbs = join(cloneDir, targetRel);
  if (existsSync(targetAbs)) {
    return { ok: false, reason: `cases/${manifest.domain}/${caseId}/ already exists in fork — pass a different --case-id`, cloneDir };
  }
  const copied = copyBundleInto(opts.bundleDir, targetAbs);
  if (copied === 0) {
    return { ok: false, reason: 'bundle is empty (no files copied)', cloneDir };
  }

  // 4. commit
  const add = run('git', ['add', '-A'], cloneDir, !!opts.verbose);
  if (add.status !== 0) {
    return { ok: false, reason: `git add failed: ${add.stderr?.trim()}`, cloneDir };
  }
  const commit = run('git', ['commit', '-m', title], cloneDir, !!opts.verbose);
  if (commit.status !== 0) {
    return { ok: false, reason: `git commit failed: ${commit.stderr?.trim()}`, cloneDir };
  }

  if (opts.dryRun) {
    return { ok: true, branch, caseId, cloneDir, upstream };
  }

  // 5. push
  const push = run('git', ['push', '--set-upstream', 'origin', branch], cloneDir, !!opts.verbose);
  if (push.status !== 0) {
    return { ok: false, reason: `git push failed: ${push.stderr?.trim()}`, cloneDir };
  }

  // 6. open PR
  const pr = run('gh', ['pr', 'create', '--repo', upstream, '--title', title, '--body', body, '--head', branch], cloneDir, !!opts.verbose);
  if (pr.status !== 0) {
    return { ok: false, reason: `gh pr create failed: ${pr.stderr?.trim()}`, cloneDir };
  }
  const prUrl = pr.stdout?.trim().split('\n').pop() || undefined;
  return { ok: true, prUrl, branch, caseId, cloneDir, upstream };
}
