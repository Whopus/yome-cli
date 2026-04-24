// skillsIndex.ts — fast lookup table for installed skills.
//
// Background: `listInstalled()` walks ~/.yome/skills/<owner>/<name>/
// and parses every yome-skill.json on every call. With 20+ installed
// skills + every CLI invocation reloading the agent, that's a measurable
// startup cost.
//
// We maintain a sidecar at ~/.yome/skills/.index.json that mirrors a
// summary of every install. The CLI updates the index whenever it
// installs / uninstalls / enables / disables / links / unlinks.
//
// The index is treated as a CACHE, not source of truth: any consumer
// that detects corruption falls back to a full directory walk. Callers
// who want to be sure the index is current call `rebuildIndex()`.
//
// Schema (forward-compatible — missing fields are filled in by reload):
//
//     {
//       version: 1,
//       built_at: ISO,
//       skills: [
//         { slug, domain, version, name?, description?,
//           installedAt, status: 'enabled'|'disabled',
//           is_dev_link, declared_capabilities, allowed_capabilities }
//       ]
//     }

import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { listInstalled } from './list.js';
import { isSkillDisabled } from './enable.js';
import { readAllowedCapabilities, normaliseDeclared } from './capabilities.js';
import { getYomeSkillsRoot } from './paths.js';

export interface SkillIndexEntry {
  slug: string;
  domain: string;
  version: string;
  name?: string;
  description?: string;
  installedAt: string;
  status: 'enabled' | 'disabled';
  is_dev_link: boolean;
  /** What the manifest declares it needs. */
  declared_capabilities: string[];
  /** What the user has granted (subset of declared). */
  allowed_capabilities: string[];
}

export interface SkillIndex {
  version: 1;
  built_at: string;
  skills: SkillIndexEntry[];
}

export function getIndexPath(): string {
  return join(getYomeSkillsRoot(), '.index.json');
}

/** Build a fresh index by walking the filesystem. */
export function rebuildIndex(): SkillIndex {
  const installed = listInstalled();
  const skills: SkillIndexEntry[] = installed.map((e) => {
    const declared = normaliseDeclared(e.manifest.system_capabilities);
    const allowed = readAllowedCapabilities(e.slug)?.allowed ?? [];
    let isLink = false;
    try { isLink = lstatSync(e.installedAt).isSymbolicLink(); } catch { /* ignore */ }
    return {
      slug: e.slug,
      domain: e.domain,
      version: e.version,
      name: e.name,
      description: e.description,
      installedAt: e.installedAt,
      status: isSkillDisabled(e.slug) ? 'disabled' : 'enabled',
      is_dev_link: isLink,
      declared_capabilities: declared,
      allowed_capabilities: allowed,
    };
  });
  const idx: SkillIndex = {
    version: 1,
    built_at: new Date().toISOString(),
    skills,
  };
  return idx;
}

export function writeIndex(idx: SkillIndex): void {
  const f = getIndexPath();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(idx, null, 2) + '\n');
}

/** Convenience: rebuild + persist. Call from install / uninstall / enable / disable / link / unlink. */
export function refreshIndex(): SkillIndex {
  const idx = rebuildIndex();
  writeIndex(idx);
  return idx;
}

/**
 * Read the index from disk. Returns null on any error so the caller can
 * fall back to a full walk via `rebuildIndex()`.
 */
export function readIndex(): SkillIndex | null {
  const f = getIndexPath();
  if (!existsSync(f)) return null;
  try {
    const obj = JSON.parse(readFileSync(f, 'utf-8'));
    if (!obj || typeof obj !== 'object') return null;
    if (obj.version !== 1) return null;
    if (!Array.isArray(obj.skills)) return null;
    return obj as SkillIndex;
  } catch { return null; }
}

/**
 * Get the canonical list of installed skills:
 *   - If the index is present and parseable, use it (fast path).
 *   - Otherwise, walk the filesystem and silently rebuild the index.
 */
export function getInstalledFast(): SkillIndexEntry[] {
  const idx = readIndex();
  if (idx) return idx.skills;
  return refreshIndex().skills;
}
