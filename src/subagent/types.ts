import type { ToolDef } from '../types.js';

export type AgentSource = 'built-in' | 'user' | 'project';

export interface AgentDefinition {
  agentType: string;
  whenToUse: string;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  model?: string;
  maxTurns?: number;
  source: AgentSource;
  getSystemPrompt: () => string;
}

export interface AgentDefinitionsResult {
  activeAgents: AgentDefinition[];
  allAgents: AgentDefinition[];
  failedFiles?: Array<{ path: string; error: string }>;
}
