import type {
  ToolPermissionContext,
  PermissionDecision,
  PermissionResult,
  PermissionRule,
  PermissionRuleSource,
} from './types.js';
import { parseRuleValue, toolMatchesRule, contentMatchesRule } from './ruleParser.js';

const RULE_SOURCES: PermissionRuleSource[] = ['cliArg', 'session', 'userSettings', 'projectSettings'];

function getAllowRules(ctx: ToolPermissionContext): PermissionRule[] {
  return RULE_SOURCES.flatMap((source) =>
    (ctx.allowRules[source] ?? []).map((s) => ({
      source,
      ruleBehavior: 'allow' as const,
      ruleValue: parseRuleValue(s),
    })),
  );
}

function getDenyRules(ctx: ToolPermissionContext): PermissionRule[] {
  return RULE_SOURCES.flatMap((source) =>
    (ctx.denyRules[source] ?? []).map((s) => ({
      source,
      ruleBehavior: 'deny' as const,
      ruleValue: parseRuleValue(s),
    })),
  );
}

/**
 * Check if the entire tool is denied by a rule.
 */
function isToolDenied(ctx: ToolPermissionContext, toolName: string): boolean {
  return getDenyRules(ctx).some((r) => toolMatchesRule(toolName, r.ruleValue));
}

/**
 * Check if the entire tool is allowed by a rule.
 */
function isToolAllowed(ctx: ToolPermissionContext, toolName: string): boolean {
  return getAllowRules(ctx).some((r) => toolMatchesRule(toolName, r.ruleValue));
}

/**
 * Check if a specific command/path is allowed by a content-specific rule.
 */
export function isContentAllowed(ctx: ToolPermissionContext, toolName: string, content: string): boolean {
  return getAllowRules(ctx).some((r) => contentMatchesRule(toolName, content, r.ruleValue));
}

/**
 * Check if a specific command/path is denied by a content-specific rule.
 */
export function isContentDenied(ctx: ToolPermissionContext, toolName: string, content: string): boolean {
  return getDenyRules(ctx).some((r) => contentMatchesRule(toolName, content, r.ruleValue));
}

/**
 * Main permission check for a tool invocation.
 *
 * @param toolName - The tool being invoked
 * @param isReadOnly - Whether the tool is read-only
 * @param ctx - Current permission context
 * @param toolResult - Optional result from the tool's own checkPermissions()
 */
export function checkPermission(
  toolName: string,
  isReadOnly: boolean,
  ctx: ToolPermissionContext,
  toolResult?: PermissionResult,
): PermissionDecision {
  // 1. Check deny rules (always respected)
  if (isToolDenied(ctx, toolName)) {
    return { behavior: 'deny', message: `Permission to use ${toolName} has been denied.` };
  }

  // 2. Tool-specific deny
  if (toolResult?.behavior === 'deny') {
    return toolResult;
  }

  // 3. Bypass mode allows everything
  if (ctx.mode === 'bypassPermissions') {
    return { behavior: 'allow' };
  }

  // 4. Accept-edits mode: allow read-only tools + file edit tools
  if (ctx.mode === 'acceptEdits') {
    if (isReadOnly) return { behavior: 'allow' };
    const editTools = ['Edit', 'Write'];
    if (editTools.includes(toolName)) return { behavior: 'allow' };
    // Bash still needs ask unless explicitly allowed
  }

  // 5. Explicit allow rules
  if (isToolAllowed(ctx, toolName)) {
    return { behavior: 'allow' };
  }

  // 6. Tool-specific ask/allow
  if (toolResult?.behavior === 'allow') {
    return toolResult;
  }
  if (toolResult?.behavior === 'ask') {
    return toolResult;
  }

  // 7. Read-only tools are always allowed
  if (isReadOnly) {
    return { behavior: 'allow' };
  }

  // 8. Default: ask for write operations
  return { behavior: 'ask', message: `Allow ${toolName} to proceed?` };
}
