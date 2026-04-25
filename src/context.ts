import { execSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { loadAllSkills } from './skills/index.js';
import type { Skill } from './skills/index.js';
import { getInstalledFast } from './yomeSkills/skillsIndex.js';
import { readManifest } from './yomeSkills/manifest.js';

function safeExec(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function getFileTree(dir: string, depth = 2, prefix = ''): string {
  if (depth < 0) return '';
  const lines: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const filtered = entries.filter(
      (e) => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__',
    );
    for (const entry of filtered.slice(0, 30)) {
      const isDir = entry.isDirectory();
      lines.push(`${prefix}${entry.name}${isDir ? '/' : ''}`);
      if (isDir && depth > 0) {
        lines.push(getFileTree(join(dir, entry.name), depth - 1, prefix + '  '));
      }
    }
    if (filtered.length > 30) lines.push(`${prefix}... (${filtered.length - 30} more)`);
  } catch { /* ignore */ }
  return lines.filter(Boolean).join('\n');
}

// ── Caches for the per-cwd metadata block ───────────────────────────
//
// `buildSystemPrompt()` runs on agent construction AND on every
// resetContext / restoreSession / reloadSkills. Each call previously
// shelled out to `git rev-parse`, `git status --porcelain`, and walked
// the project tree synchronously. On a busy session that's a measurable
// stutter every time the user runs `/new` or installs a skill.
//
// Cache key: cwd. TTL: 60s. Long enough that interactive use is fast,
// short enough that branch switches / git status changes show up
// without a CLI restart.
interface CwdMetaCache {
  cwd: string;
  expiresAt: number;
  gitBranch: string | null;
  gitStatus: string | null;
  tree: string;
}
let _cwdMetaCache: CwdMetaCache | null = null;
const CWD_META_TTL_MS = 60_000;

function getCwdMeta(cwd: string): CwdMetaCache {
  const now = Date.now();
  if (_cwdMetaCache && _cwdMetaCache.cwd === cwd && _cwdMetaCache.expiresAt > now) {
    return _cwdMetaCache;
  }
  _cwdMetaCache = {
    cwd,
    expiresAt: now + CWD_META_TTL_MS,
    gitBranch: safeExec('git rev-parse --abbrev-ref HEAD', cwd),
    gitStatus: safeExec('git status --porcelain', cwd),
    tree: getFileTree(cwd),
  };
  return _cwdMetaCache;
}

/** Force a re-fetch of git/tree info on next buildSystemPrompt call. */
export function invalidateCwdMeta(): void {
  _cwdMetaCache = null;
}

export function buildSystemPrompt(): string {
  const cwd = process.cwd();
  const projectName = basename(cwd);
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

  const meta = getCwdMeta(cwd);
  const gitBranch = meta.gitBranch;
  const gitStatus = meta.gitStatus;
  const isGit = gitBranch !== null;
  const tree = meta.tree;

  let prompt = `You are Yome, an AI coding assistant running in the user's terminal.
You help with software engineering tasks: reading code, writing code, debugging, refactoring, and running commands.

## Environment
- Date: ${dateStr}
- Working directory: ${cwd}
- Project: ${projectName}
- OS: ${process.platform} ${process.arch}
- Node: ${process.version}
`;

  if (isGit) {
    prompt += `- Git branch: ${gitBranch}\n`;
    if (gitStatus) {
      const statusLines = gitStatus.split('\n').slice(0, 20);
      prompt += `- Git status:\n${statusLines.map((l) => `  ${l}`).join('\n')}\n`;
    }
  }

  if (tree) {
    prompt += `\n## Project Structure\n\`\`\`\n${tree}\n\`\`\`\n`;
  }

  prompt += `
## Guidelines
- Use absolute paths when calling tools.
- Read files before editing them.
- Be concise in responses.
- When editing code, preserve the existing style and patterns.
- NEVER wrap your response in \`\`\`markdown fences. Output markdown directly — the terminal renders it natively.
- Verify changes work before reporting completion.
- Never expose secrets or API keys.

## Available Tools
You have these tools: Read, Edit, Write, Bash, Glob, Grep, LS.
- Use Read to view file contents.
- Use Edit to modify existing files (find & replace with old_string/new_string).
- Use Write to create new files.
- Use Bash to run shell commands.
- Use Glob to find files by pattern.
- Use Grep to search file contents.
- Use LS to list directory contents.
`;

  // Prompt-style skills (Claude Code-format SKILL.md). The agent injects
  // their markdown bodies into the prompt at /skill-name invocation time;
  // here we just advertise them so the model knows they exist.
  const skills = loadAllSkills();
  if (skills.length > 0) {
    prompt += buildSkillsSection(skills);
  }

  // Hub skills (yome-skill.json packages) — these carry typed command
  // contracts and capability grants. Every installed + enabled hub skill
  // is exposed to the model so it can reach for the right command
  // (e.g. ppt.slide.add) instead of trying to roll one from shell.
  const hubSkills = getInstalledFast().filter((s) => s.status === 'enabled');
  if (hubSkills.length > 0) {
    prompt += buildHubSkillsSection(hubSkills);
  }

  return prompt;
}

/**
 * Prompt skills (Claude Code SKILL.md format) get the same 3-row L1
 * shape as hub skills, just with different field sources:
 *   when    ← frontmatter `when_to_use` (or `description` as fallback)
 *   effects ← always "loads markdown body into context (prompt-only)"
 *             unless the SKILL.md explicitly grants `allowed-tools`
 *   start   ← `/skill-name [argument-hint]`
 *
 * Same visual shape means the model doesn't have to context-switch
 * between two different docs styles when scanning available skills.
 */
function buildSkillsSection(skills: Skill[]): string {
  let section = `\n## Available Skills (prompt)\nUser invokes with \`/skill-name [args]\`; you can invoke them too when appropriate.\n\n`;
  for (const skill of skills) {
    const head = `/${skill.name}`;
    const pad = ' '.repeat(head.length);
    const when = skill.whenToUse ?? skill.description;
    const entry = skill.argumentHint ? `/${skill.name} ${skill.argumentHint}` : `/${skill.name}`;
    const effects = (skill.allowedTools && skill.allowedTools.length > 0)
      ? `runs tools: ${skill.allowedTools.join(', ')}`
      : `prompt-only (no tools)`;

    section += `${head} | when:    ${when}\n`;
    section += `${pad} | effects: ${effects}\n`;
    section += `${pad} | start:   ${entry}\n`;
  }
  return section;
}

/**
 * Hub skills are surfaced to the LLM in three layers:
 *   L1 — this section: ONE skill = THREE short rows answering the only
 *        questions the model actually has when picking a tool —
 *          when    (trigger condition)
 *          effects (truthful side effects)
 *          start   (first command to discover the rest)
 *        Authored as `l1: { when, entry, effects }` in yome-skill.json.
 *   L2 — `<domain> --help` (kernel reads SIGNATURE.md, fallback auto-gen).
 *   L3 — `<domain> --doc [name]` for cookbook templates / themes.
 *
 * The model is told once, in the footer, that --help / --doc / batch exist
 * for every installed skill — so individual L1 blocks stay focused on
 * the trigger / effects / entry triad.
 */
function buildHubSkillsSection(entries: ReturnType<typeof getInstalledFast>): string {
  let section = `\n## Installed Hub Skills\nUse the Bash tool: \`<domain> <action> [args]\` (no \`yome\` prefix, no SkillCall).\n\n`;
  for (const e of entries) {
    const manifest = readManifest(e.installedAt);
    section += renderL1Block(e.domain, manifest, e.description) + '\n';
  }
  section += `\nFor any installed skill:
  \`<domain> --help\`           one-screen signature (actions + args)
  \`<domain> --doc\`            list cookbook templates / themes
  \`<domain> --doc <name>\`     read one template
  \`<domain> batch <<EOF…EOF\`  run several sub-commands in one call (--keep-going, --merge)
`;
  return section;
}

/**
 * Render the 3-row pipe-aligned L1 block for one skill. Falls back to
 * legacy `prompt_line`, then to `<domain> — <description>` so older
 * yome-skill.json files keep producing *something* useful.
 */
function renderL1Block(domain: string, manifest: ReturnType<typeof readManifest>, fallbackDesc?: string): string {
  const l1 = manifest?.l1;

  if (l1 && (l1.when || l1.entry || l1.effects)) {
    // Right-pad the domain column so the pipes line up vertically — easier
    // for the model to scan when several skills are listed.
    const head = domain;
    const pad = ' '.repeat(head.length);
    const lines: string[] = [];
    if (l1.when)    lines.push(`${head} | when:    ${l1.when}`);
    if (l1.effects) lines.push(`${pad} | effects: ${l1.effects}`);
    if (l1.entry)   lines.push(`${pad} | start:   ${l1.entry}`);
    return lines.join('\n');
  }

  // Legacy single-line fallback — keeps backward compat with skills that
  // used `prompt_line` before the structured l1 schema landed.
  if (manifest?.prompt_line) {
    return `- ${manifest.prompt_line}`;
  }

  return `- ${domain} — ${fallbackDesc ?? '(no description provided)'}`;
}
