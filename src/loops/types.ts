import type { YomeConfig } from '../config.js';
import type { ContentBlock, AgentMessage, AnthropicTool } from '../types.js';

export interface AgentLoopCallbacks {
  onTextDelta: (text: string) => void;
  onToolUse: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, result: string) => void;
  onDone: (usage: { inputTokens: number; outputTokens: number }) => void;
  onError: (error: Error) => void;
}

export interface AgentLoopContext {
  config: YomeConfig;
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AnthropicTool[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
}

export type UserInput = string | ContentBlock[];

export function userInputAsText(input: UserInput): string {
  if (typeof input === 'string') return input;
  return input
    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export interface AgentLoop {
  readonly name: string;
  readonly description: string;
  run(userMessage: UserInput, context: AgentLoopContext, callbacks: AgentLoopCallbacks): Promise<void>;
}

export interface AgentLoopRegistry {
  get(name: string): AgentLoop | undefined;
  list(): AgentLoop[];
  register(loop: AgentLoop): void;
  default(): AgentLoop;
}
