import type { PermissionRuleValue } from './types.js';

/**
 * Parse a permission rule string like "Bash" or "Bash(npm publish:*)" into a
 * PermissionRuleValue.
 */
export function parseRuleValue(ruleString: string): PermissionRuleValue {
  const trimmed = ruleString.trim();
  const parenIdx = trimmed.indexOf('(');
  if (parenIdx === -1) {
    return { toolName: trimmed };
  }
  const toolName = trimmed.slice(0, parenIdx).trim();
  const endParen = trimmed.lastIndexOf(')');
  const ruleContent = trimmed.slice(parenIdx + 1, endParen === -1 ? undefined : endParen).trim();
  if (!ruleContent || ruleContent === '*') {
    return { toolName };
  }
  return { toolName, ruleContent };
}

/**
 * Serialize a PermissionRuleValue back to string.
 */
export function serializeRuleValue(rule: PermissionRuleValue): string {
  if (rule.ruleContent) {
    return `${rule.toolName}(${rule.ruleContent})`;
  }
  return rule.toolName;
}

/**
 * Check if a tool matches a rule.
 * - Rule "Bash" matches tool "Bash"
 * - Rule "Bash(npm:*)" does NOT match at the tool level (has content)
 */
export function toolMatchesRule(toolName: string, ruleValue: PermissionRuleValue): boolean {
  if (ruleValue.ruleContent !== undefined) {
    return false;
  }
  return ruleValue.toolName === toolName;
}

/**
 * Check if a command/path matches a rule's content using prefix matching.
 * - "npm publish:*" matches "npm publish ..." (prefix)
 * - "npm:*" matches "npm ..."
 * - Exact match also works
 */
export function contentMatchesRule(toolName: string, content: string, ruleValue: PermissionRuleValue): boolean {
  if (ruleValue.toolName !== toolName) return false;
  if (ruleValue.ruleContent === undefined) return true;

  const rc = ruleValue.ruleContent;

  // Wildcard suffix: "npm:*" or "npm publish:*"
  if (rc.endsWith(':*')) {
    const prefix = rc.slice(0, -2);
    return content.startsWith(prefix);
  }

  // Exact match
  return content === rc;
}
