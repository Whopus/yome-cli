import type { ToolDef, AnthropicTool } from '../types.js';
import type { ToolPermissionContext, PermissionDecision } from '../permissions/types.js';
import { checkPermission } from '../permissions/checker.js';
import { readTool } from './read.js';
import { editTool } from './edit.js';
import { writeTool } from './write.js';
import { bashTool } from './bash.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { lsTool } from './ls.js';

const DEFAULT_MAX_RESULT_CHARS = 20_000;

// NOTE: We deliberately do NOT register a `SkillCall` tool any more.
// Hub skill invocations are handled by the agentic bash kernel — the
// model just emits `<domain> <action> ...` through the Bash tool and
// `tryKernel()` (in cli/src/skills/runner/kernel.ts) routes it to the
// same dispatcher SkillCall used to use, with capability checks intact.
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

/** Current permission context — set via setPermissionContext(). */
let _permCtx: ToolPermissionContext | null = null;

/**
 * Result returned by the UI after the user resolves an approval prompt.
 * - allow:    proceed with this single invocation
 * - deny:     refuse this invocation; optional `feedback` is forwarded to the model
 *             and `abort` cancels the rest of the current tool_use batch
 */
export type AskPermissionResult =
  | { decision: 'allow' }
  | { decision: 'deny'; feedback?: string; abort?: boolean };

/** Callback invoked when a tool needs user approval. */
let _askPermissionFn:
  | ((toolName: string, message: string, input: Record<string, unknown>) => Promise<AskPermissionResult>)
  | null = null;

export function setPermissionContext(ctx: ToolPermissionContext): void {
  _permCtx = ctx;
}

export function getPermissionContext(): ToolPermissionContext | null {
  return _permCtx;
}

/**
 * Register a callback that will be called when a tool requires user approval.
 * Return an AskPermissionResult describing the user's choice.
 */
export function setAskPermissionHandler(
  fn: (toolName: string, message: string, input: Record<string, unknown>) => Promise<AskPermissionResult>,
): void {
  _askPermissionFn = fn;
}

/**
 * Sentinel substring embedded in tool_result content when the user explicitly
 * rejects a tool_use. Loops detect this prefix to short-circuit the remaining
 * tool_use blocks in the same model turn (mirrors claude-code's REJECT_MESSAGE
 * + cancelAndAbort behavior).
 */
export const REJECT_SENTINEL = '[YOME_PERMISSION_DENIED]';

const DENIAL_GUIDANCE =
  'IMPORTANT: You may attempt the user\'s underlying goal with a different tool or approach, ' +
  'but do not try to bypass the intent of this denial. If you cannot proceed without this ' +
  'capability, stop and explain to the user what you were trying to do and why.';

function buildRejectMessage(toolName: string, feedback?: string): string {
  const base =
    `${REJECT_SENTINEL} The user rejected the ${toolName} tool use. ` +
    `The action was NOT performed (no files changed, no commands executed). ` +
    `Stop the current plan and wait for the user's next instruction unless they provided guidance below.`;
  const tail = feedback && feedback.trim()
    ? `\nUser feedback: ${feedback.trim()}`
    : '';
  return `${base}${tail}\n${DENIAL_GUIDANCE}`;
}

function buildAutoDenyMessage(toolName: string, reason: string): string {
  return `${REJECT_SENTINEL} Permission to use ${toolName} was denied by a configured rule: ${reason}. ${DENIAL_GUIDANCE}`;
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

  // Permission check
  if (_permCtx) {
    const toolResult = tool.checkPermissions?.(input, _permCtx);
    const decision: PermissionDecision = checkPermission(
      tool.name,
      tool.isReadOnly(),
      _permCtx,
      toolResult ?? undefined,
    );

    if (decision.behavior === 'deny') {
      return buildAutoDenyMessage(tool.name, decision.message);
    }

    if (decision.behavior === 'ask') {
      if (_askPermissionFn) {
        const result = await _askPermissionFn(tool.name, decision.message, input);
        if (result.decision === 'deny') {
          if (result.abort) {
            // Hard abort — caller listens on its own AbortSignal but we still
            // return a synthetic tool_result so the model gets a chance to see
            // why we stopped before the loop short-circuits.
            try { (signal as any)?.controller?.abort?.(); } catch { /* noop */ }
          }
          return buildRejectMessage(tool.name, result.feedback);
        }
      }
      // If no handler is registered, fall through and allow (default permissive)
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
