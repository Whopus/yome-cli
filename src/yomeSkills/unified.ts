// cli/src/yomeSkills/unified.ts
//
// Unified skill view across the two skill systems Yome supports:
//   1. Prompt skills (Claude Code-compatible SKILL.md FORMAT)
//      - SKILL.md with optional YAML frontmatter
//      - The body is dropped into the agent prompt when triggered
//      - Discovered under 2 roots (yome's own dirs, NOT ~/.claude):
//          ~/.yome/skills/<name>/SKILL.md       (yome global)
//          <cwd>/.yome/skills/<name>/SKILL.md   (yome project)
//      - We support the FORMAT (so users can drop a Claude SKILL.md
//        unchanged into our directories) but we don't read Claude's own
//        directories — those belong to Claude Code, not us.
//   2. Hub skills (yome-skill.json — typed command packages)
//      - Discovered under ~/.yome/skills/<owner>/<name>/yome-skill.json
//      - Carry capability grants, backends, signature contracts
//      - Installed via `yome skill install ...` from local / github
//
// Both render in the same /skills TUI; users don't need to remember
// which kind they're looking at unless they want to. The `kind` field
// tells the UI which actions apply.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadAllSkills, getUserSkillsDir, getProjectSkillsDir } from '../skills/loader.js';
import type { Skill as PromptSkill } from '../skills/types.js';
import { getInstalledFast } from './skillsIndex.js';
import { isSkillDisabled as isHubSkillDisabled } from './enable.js';
import { isSkillDisabled as isPromptSkillDisabled } from '../toggleState.js';

export type UnifiedSkillKind = 'prompt' | 'hub';
export type PromptOrigin = 'yome-user' | 'yome-project';

export interface UnifiedSkill {
  /** Stable identifier across reloads. */
  id: string;
  /** What the user sees first in the list. */
  name: string;
  /** Long-form, what the skill does. */
  description: string;
  kind: UnifiedSkillKind;
  enabled: boolean;
  /** Path to the skill's directory or main file (for "open" actions). */
  installedAt: string;

  /** ── prompt-only fields ────────────────────────────────────────── */
  promptOrigin?: PromptOrigin;
  promptSkill?: PromptSkill;

  /** ── hub-only fields ───────────────────────────────────────────── */
  slug?: string;
  domain?: string;
  version?: string;
  source?: string;                  // installed source (e.g. github:Whopus/...)
  declaredCapabilities?: string[];
  allowedCapabilities?: string[];
  isDevLink?: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// Prompt skill discovery (yome dirs only — never .claude)
// ──────────────────────────────────────────────────────────────────────
//
// We support the Claude Code SKILL.md FORMAT (so users can drop a
// claude-style skill file unchanged into our directories), but we do
// NOT scan ~/.claude/skills or <cwd>/.claude/skills — those belong to
// Claude Code, not to us. Surfacing them here would mix in another
// product's skills and confuse the user.

interface FrontmatterParsed {
  description?: string;
  whenToUse?: string;
}

function parseFrontmatterMinimal(raw: string): FrontmatterParsed {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm: FrontmatterParsed = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\S[\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const k = kv[1];
    const v = kv[2].trim().replace(/^["']|["']$/g, '');
    if (k === 'description') fm.description = v;
    else if (k === 'when_to_use') fm.whenToUse = v;
  }
  return fm;
}

interface RawPromptSkill {
  name: string;
  description: string;
  skillDir: string;
  origin: PromptOrigin;
}

function discoverPromptSkillsAt(dir: string, origin: PromptOrigin): RawPromptSkill[] {
  if (!existsSync(dir)) return [];
  const out: RawPromptSkill[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir).filter((n) => {
      try { return statSync(join(dir, n)).isDirectory(); } catch { return false; }
    });
  } catch { return out; }

  for (const name of entries) {
    const skillDir = join(dir, name);
    const skillFile = join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    let raw = '';
    try { raw = readFileSync(skillFile, 'utf-8'); } catch { continue; }
    const fm = parseFrontmatterMinimal(raw);
    const description =
      fm.description
      ?? raw
        .replace(/^---[\s\S]*?---/, '')
        .split('\n')
        .find((l) => l.trim().length > 0 && !l.startsWith('#'))
        ?.trim()
      ?? `Skill: ${name}`;
    out.push({ name, description, skillDir, origin });
  }
  return out;
}

/**
 * Discover prompt-style skills under yome's two roots only:
 *   ~/.yome/skills/<name>/SKILL.md       (user)
 *   <cwd>/.yome/skills/<name>/SKILL.md   (project)
 * Project-level wins over user-level on name collision.
 */
export function discoverAllPromptSkills(): RawPromptSkill[] {
  const yomeUser = discoverPromptSkillsAt(getUserSkillsDir(), 'yome-user');
  const yomeProject = discoverPromptSkillsAt(getProjectSkillsDir(), 'yome-project');

  const byName = new Map<string, RawPromptSkill>();
  for (const s of [...yomeUser, ...yomeProject]) {
    byName.set(s.name, s);
  }
  return Array.from(byName.values());
}

// ──────────────────────────────────────────────────────────────────────
// Unified loader
// ──────────────────────────────────────────────────────────────────────

/**
 * Returns every skill the agent could currently use, both prompt and hub.
 *
 * Note: yome-style hub skills live at <owner>/<name>/yome-skill.json. The
 * top-level dir under ~/.yome/skills is therefore an OWNER for hub skills
 * but a SKILL NAME for prompt skills. We disambiguate by checking which
 * file lives in the dir — the prompt loader looks for SKILL.md and the
 * hub loader looks for yome-skill.json — so they never accidentally
 * cross-contaminate.
 */
export function listAllUnified(includeDisabled = true): UnifiedSkill[] {
  const out: UnifiedSkill[] = [];

  // Prompt skills (4 roots, dedup by name).
  const promptSkills = loadAllSkills(true);          // includeDisabled — we filter below
  const rawByName = new Map<string, RawPromptSkill>();
  for (const r of discoverAllPromptSkills()) rawByName.set(r.name, r);

  for (const ps of promptSkills) {
    const raw = rawByName.get(ps.name);
    const origin: PromptOrigin =
      raw?.origin ?? (ps.source === 'project' ? 'yome-project' : 'yome-user');
    out.push({
      id: `prompt:${origin}:${ps.name}`,
      name: ps.name,
      description: ps.description,
      kind: 'prompt',
      enabled: !isPromptSkillDisabled(ps.name),
      installedAt: ps.skillDir,
      promptOrigin: origin,
      promptSkill: ps,
    });
  }

  // Also surface claude-only skills that loadAllSkills doesn't see (it
  // only walks the .yome/* dirs). discoverAllPromptSkills covers
  // all 4 roots, so anything from .claude/* not already added above
  // gets injected here.
  for (const raw of rawByName.values()) {
    const alreadyAdded = out.some((u) => u.kind === 'prompt' && u.name === raw.name);
    if (alreadyAdded) continue;
    out.push({
      id: `prompt:${raw.origin}:${raw.name}`,
      name: raw.name,
      description: raw.description,
      kind: 'prompt',
      enabled: !isPromptSkillDisabled(raw.name),
      installedAt: raw.skillDir,
      promptOrigin: raw.origin,
    });
  }

  // Hub skills.
  const hubEntries = getInstalledFast();
  for (const h of hubEntries) {
    out.push({
      id: `hub:${h.slug}`,
      name: h.name ?? h.slug,
      description: h.description ?? `${h.domain} ${h.version}`,
      kind: 'hub',
      enabled: !isHubSkillDisabled(h.slug) && h.status === 'enabled',
      installedAt: h.installedAt,
      slug: h.slug,
      domain: h.domain,
      version: h.version,
      declaredCapabilities: h.declared_capabilities,
      allowedCapabilities: h.allowed_capabilities,
      isDevLink: h.is_dev_link,
    });
  }

  if (!includeDisabled) {
    return out.filter((s) => s.enabled);
  }
  return out;
}

/** Pretty label for the origin (used in TUI). */
export function originLabel(s: UnifiedSkill): string {
  if (s.kind === 'hub') return s.isDevLink ? 'hub (dev-link)' : 'hub';
  switch (s.promptOrigin) {
    case 'yome-user':    return 'prompt · ~/.yome';
    case 'yome-project': return 'prompt · .yome';
    default:             return 'prompt';
  }
}
