// ── Content blocks (Anthropic message format) ──

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

// ── Messages ──

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

// ── API types ──

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface AnthropicResponse {
  id: string;
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage: { input_tokens: number; output_tokens: number };
}

// ── Tool definition ──

export type ToolValidationResult =
  | { valid: true }
  | { valid: false; error: string };

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: AnthropicTool['input_schema'];

  /** Max chars before result is truncated. Default: 20000. */
  readonly maxResultChars?: number;

  /** If true, this tool never modifies the filesystem/environment. */
  isReadOnly(): boolean;

  /** Validate input before execution. Return error string or null. */
  validateInput?(input: Record<string, unknown>): ToolValidationResult;

  /** Extract primary file/dir path from input (for display, permissions). */
  getPath?(input: Record<string, unknown>): string | undefined;

  /** Execute the tool. Receives an AbortSignal for cancellation. */
  execute(input: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

// ── Tool result error ──

export class ToolError extends Error {
  constructor(
    public readonly toolName: string,
    message: string,
    public readonly exitCode?: number,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}
