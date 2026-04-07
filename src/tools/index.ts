import type { ToolDef, AnthropicTool } from '../types.js';
import { readTool } from './read.js';
import { editTool } from './edit.js';
import { writeTool } from './write.js';
import { bashTool } from './bash.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { lsTool } from './ls.js';

const DEFAULT_MAX_RESULT_CHARS = 20_000;

export const BASE_TOOLS: ToolDef[] = [
  readTool,
  editTool,
  writeTool,
  bashTool,
  globTool,
  grepTool,
  lsTool,
];

const toolMap = new Map<string, ToolDef>();
for (const t of BASE_TOOLS) toolMap.set(t.name, t);

export function registerTool(tool: ToolDef): void {
  toolMap.set(tool.name, tool);
}

export function getToolByName(name: string): ToolDef | undefined {
  return toolMap.get(name);
}

export function getAllTools(): ToolDef[] {
  return Array.from(toolMap.values());
}

export function getAnthropicTools(): AnthropicTool[] {
  return getAllTools().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const tool = toolMap.get(name);
  if (!tool) return `Error: Unknown tool: ${name}`;

  // Validate input if the tool supports it
  if (tool.validateInput) {
    const validation = tool.validateInput(input);
    if (!validation.valid) {
      return `Error: ${validation.error}`;
    }
  }

  try {
    let result = await tool.execute(input, signal);

    // Truncate oversized results
    const limit = tool.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
    if (result.length > limit) {
      result = result.slice(0, limit) + `\n\n[Output truncated at ${limit} chars]`;
    }

    return result;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return `Tool ${name} was cancelled.`;
    }
    return `Error executing ${name}: ${err.message}`;
  }
}
