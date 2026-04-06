import { readFileSync, writeFileSync, mkdirSync } from 'fs';
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

export function resolveConfig(flags: {
  key?: string;
  baseUrl?: string;
  model?: string;
  provider?: string;
}): YomeConfig {
  const stored = loadStoredConfig();

  const apiKey = flags.key || process.env.YOME_API_KEY || stored.apiKey || '';
  const baseUrl = (flags.baseUrl || process.env.YOME_BASE_URL || stored.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = flags.model || process.env.YOME_MODEL || stored.model;

  const providerRaw = flags.provider || process.env.YOME_PROVIDER || stored.provider;
  let provider: 'anthropic' | 'openai';
  if (providerRaw === 'openai' || providerRaw === 'anthropic') {
    provider = providerRaw;
  } else {
    provider = detectProvider(baseUrl);
  }

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
