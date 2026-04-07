import { buildSystemPrompt } from './context.js';
import { getAnthropicTools, executeTool, registerTool } from './tools/index.js';
import { loadAllSkills } from './skills/index.js';
import { createLoopRegistry } from './loops/index.js';
import { createAgentTool, clearAgentCache, getAllAgents } from './subagent/index.js';
import type { Skill } from './skills/index.js';
import type { AgentDefinition } from './subagent/index.js';
import type { AgentMessage } from './types.js';
import type { YomeConfig } from './config.js';
import type { AgentLoopCallbacks } from './loops/index.js';

export interface AgentCallbacks extends AgentLoopCallbacks {
  onLoopChanged?: (name: string) => void;
}

export class Agent {
  private config: YomeConfig;
  private messages: AgentMessage[] = [];
  private systemPrompt: string;
  private skills: Skill[] = [];
  private loopRegistry = createLoopRegistry();
  private currentLoopName = 'simple';

  constructor(config: YomeConfig) {
    this.config = config;
    this.systemPrompt = buildSystemPrompt();
    this.skills = loadAllSkills();
    registerTool(createAgentTool(config));
  }

  getSkills(): Skill[] {
    return loadAllSkills(true);
  }

  getAgents(): AgentDefinition[] {
    return getAllAgents();
  }

  reloadSkills(): void {
    this.skills = loadAllSkills();
    this.systemPrompt = buildSystemPrompt();
    clearAgentCache();
    registerTool(createAgentTool(this.config));
  }

  getCurrentLoopName(): string {
    return this.currentLoopName;
  }

  getAvailableLoops(): { name: string; description: string }[] {
    return this.loopRegistry.list().map((l) => ({ name: l.name, description: l.description }));
  }

  switchLoop(name: string): boolean {
    const loop = this.loopRegistry.get(name);
    if (!loop) return false;
    this.currentLoopName = name;
    return true;
  }

  private parseSkillInvocation(input: string): { skill: Skill; args: string } | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return null;
    const spaceIdx = trimmed.indexOf(' ');
    const name = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
    const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
    const skill = this.skills.find((s) => s.name === name);
    if (!skill) return null;
    return { skill, args };
  }

  async run(userMessage: string, callbacks: AgentCallbacks): Promise<void> {
    // Handle skill invocation
    const skillInvocation = this.parseSkillInvocation(userMessage);
    let effectiveMessage = userMessage;
    if (skillInvocation) {
      const { skill, args } = skillInvocation;
      effectiveMessage = `[Skill: /${skill.name}]\n\n${skill.getPrompt(args)}`;
    }

    const loop = this.loopRegistry.get(this.currentLoopName) ?? this.loopRegistry.default();
    const tools = getAnthropicTools();

    await loop.run(effectiveMessage, {
      config: this.config,
      systemPrompt: this.systemPrompt,
      messages: this.messages,
      tools,
      executeTool,
    }, callbacks);
  }
}
