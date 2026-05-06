import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { readFileSync as readPkg } from 'fs';
import { resolve } from 'path';

const CONFIG_DIR = join(homedir(), '.yome');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface YomeConfig {
  apiKey: string;
  baseUrl: string;
  model?: string;
  provider: 'anthropic' | 'openai';
}

export interface ModelEntry {
  id: string;
  displayName: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  provider: 'anthropic' | 'openai';
  maxOutputTokens?: number;
}

interface StoredConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  provider?: 'anthropic' | 'openai';
}

export function loadStoredConfig(): StoredConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveStoredConfig(updates: Partial<StoredConfig>): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const existing = loadStoredConfig();
  const merged = { ...existing, ...updates };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
}

export const CONFIG_PATH = CONFIG_FILE;

const DEFAULT_BASE_URL = 'https://zenmux.ai/api';

const OPENAI_COMPATIBLE_HOSTS = [
  'api.openai.com', 'api.deepseek.com', 'api.groq.com',
  'api.together.xyz', 'openrouter.ai',
  'api.minimax.io', 'api.minimaxi.com',
];
const OPENAI_COMPATIBLE_PATHS = ['/compatible-mode', '/v1/chat'];

export function detectProvider(baseUrl: string): 'anthropic' | 'openai' {
  try {
    const url = new URL(baseUrl);
    const isOpenAIHost = OPENAI_COMPATIBLE_HOSTS.some((h) => url.hostname.includes(h));
    const isOpenAIPath = OPENAI_COMPATIBLE_PATHS.some((p) => url.pathname.includes(p));
    if (isOpenAIHost || isOpenAIPath) return 'openai';
  } catch { /* invalid URL */ }
  return 'anthropic';
}

export function isMiniMaxUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname.includes('minimax.io') || hostname.includes('minimaxi.com');
  } catch {
    return false;
  }
}

/** Built-in MiniMax model definitions. */
export const MINIMAX_MODELS: ModelEntry[] = [
  {
    id: 'minimax-m2.7',
    displayName: 'MiniMax-M2.7',
    model: 'MiniMax-M2.7',
    baseUrl: 'https://api.minimax.io/v1',
    apiKey: '',
    provider: 'openai',
  },
  {
    id: 'minimax-m2.7-highspeed',
    displayName: 'MiniMax-M2.7 Highspeed',
    model: 'MiniMax-M2.7-highspeed',
    baseUrl: 'https://api.minimax.io/v1',
    apiKey: '',
    provider: 'openai',
  },
];

export function resolveConfig(flags: {
  key?: string;
  baseUrl?: string;
  model?: string;
  provider?: string;
}): YomeConfig {
  const stored = loadStoredConfig();

  const baseUrl = (flags.baseUrl || process.env.YOME_BASE_URL || stored.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = flags.model || process.env.YOME_MODEL || stored.model;

  const providerRaw = flags.provider || process.env.YOME_PROVIDER || stored.provider;
  let provider: 'anthropic' | 'openai';
  if (providerRaw === 'openai' || providerRaw === 'anthropic') {
    provider = providerRaw;
  } else {
    provider = detectProvider(baseUrl);
  }

  // Support MINIMAX_API_KEY as a convenience alias when targeting MiniMax endpoints.
  const minimaxKey = isMiniMaxUrl(baseUrl) ? process.env.MINIMAX_API_KEY : undefined;
  const apiKey = flags.key || process.env.YOME_API_KEY || minimaxKey || stored.apiKey || '';

  return { apiKey, baseUrl, model, provider };
}

let _pkgVersion: string | undefined;
export function getVersion(): string {
  if (_pkgVersion) return _pkgVersion;
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));
    _pkgVersion = pkg.version || '0.1.0';
  } catch {
    _pkgVersion = '0.1.0';
  }
  return _pkgVersion!;
}

const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json');

interface SettingsJson {
  customModels?: Array<{
    id?: string;
    displayName?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    provider?: string;
    maxOutputTokens?: number;
  }>;
  [key: string]: unknown;
}

/**
 * Load custom model entries from ~/.yome/settings.json.
 * Built-in MiniMax models are automatically included when MINIMAX_API_KEY is set.
 */
export function loadModelEntries(): ModelEntry[] {
  const custom: ModelEntry[] = (() => {
    try {
      if (!existsSync(SETTINGS_FILE)) return [];
      const raw = readFileSync(SETTINGS_FILE, 'utf-8').trim();
      if (!raw) return [];
      const data: SettingsJson = JSON.parse(raw);
      if (!Array.isArray(data.customModels)) return [];

      return data.customModels
        .filter((m) => m.model && m.baseUrl && m.apiKey)
        .map((m) => ({
          id: m.id ?? m.model!,
          displayName: m.displayName ?? m.model!,
          model: m.model!,
          baseUrl: m.baseUrl!.replace(/\/+$/, ''),
          apiKey: m.apiKey!,
          provider: (m.provider === 'openai' ? 'openai' : 'anthropic') as 'anthropic' | 'openai',
          maxOutputTokens: m.maxOutputTokens,
        }));
    } catch {
      return [];
    }
  })();

  // Inject built-in MiniMax models when MINIMAX_API_KEY is present and no custom
  // MiniMax entries already override them.
  const minimaxApiKey = process.env.MINIMAX_API_KEY;
  const builtinMiniMax: ModelEntry[] = minimaxApiKey
    ? MINIMAX_MODELS.map((m) => ({ ...m, apiKey: minimaxApiKey })).filter(
        (bm) => !custom.some((c) => c.id === bm.id || c.model === bm.model),
      )
    : [];

  return [...builtinMiniMax, ...custom];
}

/**
 * Convert a ModelEntry to a YomeConfig (for hot-swapping).
 */
export function modelEntryToConfig(entry: ModelEntry): YomeConfig {
  return {
    apiKey: entry.apiKey,
    baseUrl: entry.baseUrl,
    model: entry.model,
    provider: entry.provider,
  };
}
