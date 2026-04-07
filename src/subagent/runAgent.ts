import { callLLMStream } from '../llm.js';
import { getAnthropicTools, executeTool } from '../tools/index.js';
import { loadAllSkills } from '../skills/index.js';
import type { YomeConfig } from '../config.js';
import type { AgentMessage, ContentBlock, AnthropicTool } from '../types.js';
import type { AgentDefinition } from './types.js';

const DEFAULT_MAX_TURNS = 30;

export interface SubagentResult {
  result: string;
  messages: AgentMessage[];
  inputTokens: number;
  outputTokens: number;
}

const AGENT_TOOL_NAME = 'Agent';

function resolveAgentTools(agent: AgentDefinition): AnthropicTool[] {
  // Exclude the Agent tool itself to prevent recursive subagent spawning
  const allTools = getAnthropicTools().filter((t) => t.name !== AGENT_TOOL_NAME);

  // '*' or undefined means all tools
  if (!agent.tools || agent.tools.includes('*')) {
    if (!agent.disallowedTools?.length) return allTools;
    const deny = new Set(agent.disallowedTools);
    return allTools.filter((t) => !deny.has(t.name));
  }

  const allowSet = new Set(agent.tools);
  let filtered = allTools.filter((t) => allowSet.has(t.name));

  if (agent.disallowedTools?.length) {
    const deny = new Set(agent.disallowedTools);
    filtered = filtered.filter((t) => !deny.has(t.name));
  }

  return filtered;
}

export async function runAgent(opts: {
  config: YomeConfig;
  agent: AgentDefinition;
  prompt: string;
  signal?: AbortSignal;
  onTextDelta?: (text: string) => void;
  onToolUse?: (name: string, input: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string) => void;
}): Promise<SubagentResult> {
  const { config, agent, prompt, signal, onTextDelta, onToolUse, onToolResult } = opts;

  const effectiveConfig: YomeConfig = agent.model
    ? { ...config, model: agent.model }
    : config;

  const systemPrompt = agent.getSystemPrompt();
  const tools = resolveAgentTools(agent);
  const maxTurns = agent.maxTurns ?? DEFAULT_MAX_TURNS;

  // Isolated message history for this subagent
  const messages: AgentMessage[] = [];

  // Preload skills specified in agent definition
  if (agent.skills?.length) {
    const allSkills = loadAllSkills();
    for (const skillName of agent.skills) {
      const skill = allSkills.find((s) => s.name === skillName);
      if (!skill) continue;
      const skillPrompt = skill.getPrompt('');
      messages.push({
        role: 'user',
        content: `[Skill: /${skill.name}]\n\n${skillPrompt}`,
      });
      messages.push({
        role: 'assistant',
        content: `Understood. I have loaded the "${skill.name}" skill and will follow its instructions.`,
      });
    }
  }

  messages.push({ role: 'user', content: prompt });

  let totalInput = 0;
  let totalOutput = 0;
  let lastText = '';

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      throw new Error('Subagent was cancelled');
    }

    const response = await callLLMStream(
      effectiveConfig,
      systemPrompt,
      messages,
      tools,
      (event) => {
        if (event.type === 'text_delta' && event.text) {
          lastText += event.text;
          onTextDelta?.(event.text);
        }
      },
    );

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;
    messages.push({ role: 'assistant', content: response.content });

    const toolUseBlocks = response.content.filter(
      (b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use',
    );

    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
      break;
    }

    // Execute tool calls
    const toolResults: ContentBlock[] = [];
    for (const block of toolUseBlocks) {
      if (signal?.aborted) {
        throw new Error('Subagent was cancelled');
      }

      onToolUse?.(block.name, block.input);
      const result = await executeTool(block.name, block.input, signal);
      onToolResult?.(block.name, result);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
      });
    }

    messages.push({ role: 'user', content: toolResults });
    lastText = '';
  }

  // Extract final text from the last assistant message
  const finalText = extractFinalText(messages);

  return {
    result: finalText,
    messages,
    inputTokens: totalInput,
    outputTokens: totalOutput,
  };
}

function extractFinalText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') return msg.content;
    const textBlocks = msg.content
      .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
      .map((b) => b.text);
    if (textBlocks.length > 0) return textBlocks.join('\n');
  }
  return '(no output)';
}
