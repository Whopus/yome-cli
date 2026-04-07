import type { ToolDef } from '../types.js';
import type { YomeConfig } from '../config.js';
import type { AgentDefinition } from './types.js';
import { runAgent } from './runAgent.js';
import { loadAgentDefinitions } from './loadAgents.js';
import { GENERAL_PURPOSE_AGENT } from './builtinAgents.js';

let _cachedAgents: AgentDefinition[] | null = null;
let _cachedAllAgents: AgentDefinition[] | null = null;

export function getActiveAgents(): AgentDefinition[] {
  if (!_cachedAgents) {
    _cachedAgents = loadAgentDefinitions().activeAgents;
  }
  return _cachedAgents;
}

export function getAllAgents(): AgentDefinition[] {
  if (!_cachedAllAgents) {
    _cachedAllAgents = loadAgentDefinitions(true).activeAgents;
  }
  return _cachedAllAgents;
}

export function clearAgentCache(): void {
  _cachedAgents = null;
  _cachedAllAgents = null;
}

function getAgentToolDescription(): string {
  const agents = getActiveAgents();
  const agentLines = agents.map((a) => {
    const tools = a.tools?.includes('*') ? 'All tools' : (a.tools?.join(', ') ?? 'All tools');
    return `- ${a.agentType}: ${a.whenToUse} (Tools: ${tools})`;
  }).join('\n');

  return `Launch a new subagent to handle a complex, multi-step task autonomously.

Each subagent runs in an isolated context with its own conversation history, and returns a single result when done.

Available agent types:
${agentLines}

When using this tool, specify a subagent_type to select which agent to use. If omitted, the general-purpose agent is used.

When NOT to use this tool:
- If you want to read a specific file, use the Read tool directly.
- If you are searching for a pattern, use the Grep or Glob tool directly.
- Simple tasks that need 1-2 tool calls — do them yourself.

Usage notes:
- Write a thorough prompt: the subagent starts with zero context. Explain what you're trying to do, what you've learned, and what to look for.
- The subagent's result is NOT visible to the user. You must relay the key findings back.
- Clearly state whether the subagent should write code or only do research.
- You can launch multiple subagents in parallel by including multiple Agent tool calls in one message.`;
}

export function createAgentTool(config: YomeConfig): ToolDef {
  return {
    name: 'Agent',
    description: getAgentToolDescription(),
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of the task',
        },
        prompt: {
          type: 'string',
          description: 'The task for the subagent to perform. Be thorough — it has no context from this conversation.',
        },
        subagent_type: {
          type: 'string',
          description: 'The type of agent to use. If omitted, uses general-purpose.',
        },
      },
      required: ['description', 'prompt'],
    },
    isReadOnly() { return false; },
    validateInput(input) {
      if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
        return { valid: false, error: 'prompt is required' };
      }
      if (typeof input.description !== 'string' || !input.description.trim()) {
        return { valid: false, error: 'description is required' };
      }
      return { valid: true };
    },
    async execute(input, signal) {
      const prompt = input.prompt as string;
      const description = input.description as string;
      const subagentType = input.subagent_type as string | undefined;

      const agents = getActiveAgents();
      let agent: AgentDefinition;

      if (subagentType) {
        const found = agents.find((a) => a.agentType === subagentType);
        if (!found) {
          const available = agents.map((a) => a.agentType).join(', ');
          return `Error: Agent type '${subagentType}' not found. Available: ${available}`;
        }
        agent = found;
      } else {
        agent = agents.find((a) => a.agentType === GENERAL_PURPOSE_AGENT.agentType) ?? GENERAL_PURPOSE_AGENT;
      }

      try {
        const result = await runAgent({
          config,
          agent,
          prompt,
          signal,
        });

        const lines = [
          `Agent "${description}" completed.`,
          `Tokens: ${result.inputTokens} in / ${result.outputTokens} out`,
          ``,
          result.result,
        ];

        return lines.join('\n');
      } catch (err: any) {
        if (err.name === 'AbortError' || err.message?.includes('cancelled')) {
          return `Agent "${description}" was cancelled.`;
        }
        return `Agent "${description}" failed: ${err.message}`;
      }
    },
  };
}
