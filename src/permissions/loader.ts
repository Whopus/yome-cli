import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
  PermissionRulesBySource,
  PermissionMode,
  ToolPermissionContext,
} from './types.js';
import { parseRuleValue } from './ruleParser.js';

const USER_CONFIG_DIR = join(homedir(), '.yome');
const USER_SETTINGS_FILE = join(USER_CONFIG_DIR, 'settings.json');

interface PermissionsBlock {
  allow?: string[];
  deny?: string[];
  defaultMode?: string;
  [key: string]: string[] | string | undefined;
}

interface SettingsJson {
  permissions?: PermissionsBlock;
  [key: string]: unknown;
}

function readJsonFile(filePath: string): SettingsJson | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getProjectSettingsPath(): string {
  return resolve(process.cwd(), '.yome', 'settings.json');
}

function loadRulesFromSettings(data: SettingsJson | null, source: PermissionRuleSource): PermissionRule[] {
  if (!data?.permissions) return [];
  const rules: PermissionRule[] = [];
  const behaviors: PermissionBehavior[] = ['allow', 'deny'];
  for (const behavior of behaviors) {
    const entries = data.permissions[behavior];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      rules.push({
        source,
        ruleBehavior: behavior,
        ruleValue: parseRuleValue(entry),
      });
    }
  }
  return rules;
}

/**
 * Load all permission rules from user settings (~/.yome/settings.json)
 * and project settings (.yome/settings.json).
 */
export function loadAllPermissionRules(): PermissionRule[] {
  const rules: PermissionRule[] = [];

  const userData = readJsonFile(USER_SETTINGS_FILE);
  rules.push(...loadRulesFromSettings(userData, 'userSettings'));

  const projData = readJsonFile(getProjectSettingsPath());
  rules.push(...loadRulesFromSettings(projData, 'projectSettings'));

  return rules;
}

/**
 * Load the default permission mode from settings.
 */
export function loadDefaultMode(): PermissionMode {
  const userData = readJsonFile(USER_SETTINGS_FILE);
  const mode = userData?.permissions?.defaultMode;
  if (mode === 'acceptEdits' || mode === 'bypassPermissions') return mode;
  return 'default';
}

/**
 * Build an initial ToolPermissionContext from disk settings and CLI args.
 */
export function initializePermissionContext(opts?: {
  allowedTools?: string[];
  disallowedTools?: string[];
  mode?: PermissionMode;
}): ToolPermissionContext {
  const mode = opts?.mode ?? loadDefaultMode();
  const rules = loadAllPermissionRules();

  const allowRules: PermissionRulesBySource = {};
  const denyRules: PermissionRulesBySource = {};

  for (const rule of rules) {
    const bucket = rule.ruleBehavior === 'allow' ? allowRules : denyRules;
    if (!bucket[rule.source]) bucket[rule.source] = [];
    bucket[rule.source]!.push(
      rule.ruleValue.ruleContent
        ? `${rule.ruleValue.toolName}(${rule.ruleValue.ruleContent})`
        : rule.ruleValue.toolName,
    );
  }

  if (opts?.allowedTools?.length) {
    allowRules.cliArg = [...(allowRules.cliArg ?? []), ...opts.allowedTools];
  }
  if (opts?.disallowedTools?.length) {
    denyRules.cliArg = [...(denyRules.cliArg ?? []), ...opts.disallowedTools];
  }

  return { mode, allowRules, denyRules };
}

/**
 * Persist a new allow/deny rule to user settings.
 */
export function addPermissionRuleToUserSettings(ruleString: string, behavior: PermissionBehavior): void {
  mkdirSync(USER_CONFIG_DIR, { recursive: true });
  const data = readJsonFile(USER_SETTINGS_FILE) ?? {};
  if (!data.permissions) data.permissions = {};
  if (!data.permissions[behavior]) data.permissions[behavior] = [];
  const list = data.permissions[behavior] as string[];
  if (!list.includes(ruleString)) {
    list.push(ruleString);
  }
  writeFileSync(USER_SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Return a new ToolPermissionContext with `ruleString` appended to the given
 * source bucket under `behavior`. Pure / non-mutating — pairs naturally with
 * the immutable `ToolPermissionContext` type.
 *
 * Use `source: 'session'` for "allow for this session only" (in-memory) and
 * `source: 'userSettings'` to mirror what was just persisted to disk so the
 * decision takes effect immediately without restarting the CLI.
 */
export function addRuleToContext(
  ctx: ToolPermissionContext,
  ruleString: string,
  behavior: PermissionBehavior,
  source: PermissionRuleSource,
): ToolPermissionContext {
  const bucket = behavior === 'allow' ? { ...ctx.allowRules } : { ...ctx.denyRules };
  const existing = bucket[source] ?? [];
  if (existing.includes(ruleString)) {
    // No-op if duplicate — return original ref so React-style equality stays cheap.
    return ctx;
  }
  bucket[source] = [...existing, ruleString];
  return behavior === 'allow'
    ? { ...ctx, allowRules: bucket }
    : { ...ctx, denyRules: bucket };
}

/**
 * Best-effort extraction of a stable Bash command prefix to use as a permission
 * rule. Returns the first 1-2 plain tokens (`git status`, `npm run build`)
 * suffixed with `:*` so prefix matching catches subsequent invocations with
 * different arguments. Falls back to `null` when the command contains shell
 * metacharacters (pipes, &&, ;, redirects, subshells) — those should be approved
 * verbatim rather than turned into a wildcard rule.
 */
export function extractBashRulePrefix(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  // Refuse compound shell — too risky to auto-derive a wildcard rule.
  if (/[|&;`$<>(){}]/.test(trimmed)) return null;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const first = tokens[0]!;
  // Subcommand-style binaries: keep first two tokens (git status, npm run, kubectl get).
  const SUBCOMMAND_BINS = new Set([
    'git', 'npm', 'pnpm', 'yarn', 'bun', 'docker', 'kubectl', 'cargo', 'go', 'gh', 'brew',
  ]);
  if (SUBCOMMAND_BINS.has(first) && tokens.length >= 2 && /^[a-zA-Z][\w-]*$/.test(tokens[1]!)) {
    return `${first} ${tokens[1]}:*`;
  }
  if (!/^[\w./-]+$/.test(first)) return null;
  return `${first}:*`;
}
