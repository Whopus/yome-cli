import { readdirSync, readFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { isSkillDisabled } from '../toggleState.js';
import type { Skill, SkillFrontmatter } from './types.js';

function parseFrontmatter(raw: string): { frontmatter: SkillFrontmatter; content: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content: raw };

  const fm: SkillFrontmatter = {};
  const lines = match[1].split('\n');
  let currentKey = '';
  let inArray = false;
  const arrayBuf: string[] = [];

  for (const line of lines) {
    // Array item under a key
    if (inArray && /^\s+-\s+/.test(line)) {
      arrayBuf.push(line.replace(/^\s+-\s+/, '').trim());
      continue;
    }

    // Flush array
    if (inArray) {
      (fm as any)[currentKey] = arrayBuf.length === 1 ? arrayBuf[0] : [...arrayBuf];
      inArray = false;
      arrayBuf.length = 0;
    }

    const kvMatch = line.match(/^(\S[\w-]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const value = kvMatch[2].trim();

    if (value === '' || value === '|') {
      currentKey = key;
      inArray = true;
      continue;
    }

    // Remove quotes
    const cleaned = value.replace(/^["']|["']$/g, '');
    (fm as any)[key] = cleaned;
  }

  if (inArray && arrayBuf.length > 0) {
    (fm as any)[currentKey] = arrayBuf.length === 1 ? arrayBuf[0] : [...arrayBuf];
  }

  return { frontmatter: fm, content: match[2] };
}

function parseAllowedTools(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function loadSkillsFromDir(basePath: string, source: 'user' | 'project'): Skill[] {
  const skills: Skill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(basePath).filter((e) => {
      try {
        return statSync(join(basePath, e)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }

  for (const dirName of entries) {
    const skillDir = join(basePath, dirName);
    const skillFile = join(skillDir, 'SKILL.md');
    let raw: string;
    try {
      raw = readFileSync(skillFile, 'utf-8');
    } catch {
      continue;
    }

    const { frontmatter, content } = parseFrontmatter(raw);
    const name = dirName;
    const description = frontmatter.description
      || content.split('\n').find((l) => l.trim().length > 0 && !l.startsWith('#'))?.trim()
      || `Skill: ${name}`;

    skills.push({
      name,
      description,
      allowedTools: parseAllowedTools(frontmatter['allowed-tools']),
      argumentHint: frontmatter['argument-hint'],
      whenToUse: frontmatter.when_to_use,
      model: frontmatter.model,
      context: frontmatter.context === 'fork' ? 'fork' : 'inline',
      source,
      skillDir,
      markdownContent: content,
      getPrompt(args: string): string {
        let prompt = `Base directory for this skill: ${skillDir}\n\n${content}`;
        if (args) {
          prompt += `\n\n## User Arguments\n\n${args}`;
        }
        return prompt;
      },
    });
  }

  return skills;
}

export function getUserSkillsDir(): string {
  return join(homedir(), '.yome', 'skills');
}

export function getProjectSkillsDir(): string {
  return join(process.cwd(), '.yome', 'skills');
}

export function loadAllSkills(includeDisabled = false): Skill[] {
  const userSkills = loadSkillsFromDir(getUserSkillsDir(), 'user');
  const projectSkills = loadSkillsFromDir(getProjectSkillsDir(), 'project');

  // Deduplicate: project skills override user skills with same name
  const byName = new Map<string, Skill>();
  for (const s of userSkills) byName.set(s.name, s);
  for (const s of projectSkills) byName.set(s.name, s);

  const all = Array.from(byName.values());
  if (includeDisabled) return all;
  return all.filter((s) => !isSkillDisabled(s.name));
}
