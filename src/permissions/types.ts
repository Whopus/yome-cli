// Permission modes
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

// Permission behaviors
export type PermissionBehavior = 'allow' | 'deny' | 'ask';

// Where a rule came from
export type PermissionRuleSource = 'userSettings' | 'projectSettings' | 'cliArg' | 'session';

// A parsed rule value: "Bash" or "Bash(npm publish:*)"
export interface PermissionRuleValue {
  toolName: string;
  ruleContent?: string;
}

// A permission rule with source and behavior
export interface PermissionRule {
  source: PermissionRuleSource;
  ruleBehavior: PermissionBehavior;
  ruleValue: PermissionRuleValue;
}

// Permission decision results
export interface PermissionAllowDecision {
  behavior: 'allow';
  updatedInput?: Record<string, unknown>;
}

export interface PermissionAskDecision {
  behavior: 'ask';
  message: string;
}

export interface PermissionDenyDecision {
  behavior: 'deny';
  message: string;
}

export type PermissionDecision =
  | PermissionAllowDecision
  | PermissionAskDecision
  | PermissionDenyDecision;

// Tool-level permission result (includes passthrough)
export type PermissionResult =
  | PermissionDecision
  | { behavior: 'passthrough'; message: string };

// Rules grouped by source
export type PermissionRulesBySource = {
  [T in PermissionRuleSource]?: string[];
};

// The permission context carried through the application
export interface ToolPermissionContext {
  readonly mode: PermissionMode;
  readonly allowRules: PermissionRulesBySource;
  readonly denyRules: PermissionRulesBySource;
}
