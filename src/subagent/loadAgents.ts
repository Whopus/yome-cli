import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { isAgentDisabled } from '../toggleState.js';
import type { AgentDefinition, AgentDefinitionsResult } from './types.js';
import { getBuiltInAgents } from './builtinAgents.js';

interface AgentFrontmatter {
  name?: string;
  description?: string;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  model?: string;
  maxTurns?: number;
}

function parseFrontmatter(content: string): { frontmatter: AgentFrontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const raw = match[1]!;
  const body = match[2]!;
  const fm: Record<string, unknown> = {};

  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (typeof value === 'string' && /^\d+$/.test(value)) value = parseInt(value, 10);

    // Handle YAML arrays: tools: [Read, Write, Bash]
    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    }

    fm[key] = value;
  }

  return { frontmatter: fm as AgentFrontmatter, body };
}

function loadAgentsFromDir(dir: string, source: 'user' | 'project'): AgentDefinition[] {
  if (!existsSync(dir)) return [];

  const agents: AgentDefinition[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;

    const filePath = join(dir, entry);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    const systemPrompt = body.trim();
    if (!systemPrompt) continue;

    const agent: AgentDefinition = {
      agentType: frontmatter.name,
      whenToUse: frontmatter.description,
      source,
      getSystemPrompt: () => systemPrompt,
      ...(frontmatter.tools ? { tools: frontmatter.tools } : {}),
      ...(frontmatter.disallowedTools ? { disallowedTools: frontmatter.disallowedTools } : {}),
      ...(frontmatter.skills?.length ? { skills: frontmatter.skills } : {}),
      ...(frontmatter.model ? { model: frontmatter.model } : {}),
      ...(frontmatter.maxTurns ? { maxTurns: frontmatter.maxTurns } : {}),
    };
    agents.push(agent);
  }

  return agents;
}

export function loadAgentDefinitions(includeDisabled = false): AgentDefinitionsResult {
  const builtInAgents = getBuiltInAgents();

  const cwd = process.cwd();
  const projectAgentsDir = join(cwd, '.yome', 'agents');
  const userAgentsDir = join(homedir(), '.yome', 'agents');

  const projectAgents = loadAgentsFromDir(projectAgentsDir, 'project');
  const userAgents = loadAgentsFromDir(userAgentsDir, 'user');

  // Priority: project > user > built-in (later overrides earlier)
  const agentMap = new Map<string, AgentDefinition>();
  for (const a of builtInAgents) agentMap.set(a.agentType, a);
  for (const a of userAgents) agentMap.set(a.agentType, a);
  for (const a of projectAgents) agentMap.set(a.agentType, a);

  const allAgents = [...builtInAgents, ...userAgents, ...projectAgents];
  const deduped = Array.from(agentMap.values());
  const activeAgents = includeDisabled
    ? deduped
    : deduped.filter((a) => !isAgentDisabled(a.agentType));

  return { activeAgents, allAgents };
}
