import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { detectProvider, isMiniMaxUrl, MINIMAX_MODELS, resolveConfig } from './config.js';

describe('detectProvider', () => {
  it('returns openai for api.minimax.io URLs', () => {
    expect(detectProvider('https://api.minimax.io/v1')).toBe('openai');
  });

  it('returns openai for api.minimaxi.com URLs (Chinese domestic)', () => {
    expect(detectProvider('https://api.minimaxi.com/v1')).toBe('openai');
  });

  it('returns openai for api.openai.com', () => {
    expect(detectProvider('https://api.openai.com/v1')).toBe('openai');
  });

  it('returns openai for api.deepseek.com', () => {
    expect(detectProvider('https://api.deepseek.com/v1')).toBe('openai');
  });

  it('returns anthropic for Anthropic endpoints', () => {
    expect(detectProvider('https://api.anthropic.com')).toBe('anthropic');
  });

  it('returns anthropic for unknown endpoints', () => {
    expect(detectProvider('https://zenmux.ai/api')).toBe('anthropic');
  });
});

describe('isMiniMaxUrl', () => {
  it('returns true for api.minimax.io', () => {
    expect(isMiniMaxUrl('https://api.minimax.io/v1')).toBe(true);
  });

  it('returns true for api.minimaxi.com', () => {
    expect(isMiniMaxUrl('https://api.minimaxi.com/v1')).toBe(true);
  });

  it('returns false for non-MiniMax URLs', () => {
    expect(isMiniMaxUrl('https://api.openai.com/v1')).toBe(false);
    expect(isMiniMaxUrl('https://api.anthropic.com')).toBe(false);
  });
});

describe('MINIMAX_MODELS', () => {
  it('includes MiniMax-M2.7 model', () => {
    const m27 = MINIMAX_MODELS.find((m) => m.model === 'MiniMax-M2.7');
    expect(m27).toBeDefined();
    expect(m27!.provider).toBe('openai');
    expect(m27!.baseUrl).toBe('https://api.minimax.io/v1');
  });

  it('includes MiniMax-M2.7-highspeed model', () => {
    const hs = MINIMAX_MODELS.find((m) => m.model === 'MiniMax-M2.7-highspeed');
    expect(hs).toBeDefined();
    expect(hs!.provider).toBe('openai');
  });

  it('has exactly two models', () => {
    expect(MINIMAX_MODELS.length).toBe(2);
  });
});

describe('resolveConfig with MINIMAX_API_KEY', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.YOME_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.YOME_BASE_URL;
    delete process.env.YOME_MODEL;
    delete process.env.YOME_PROVIDER;
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
  });

  it('uses MINIMAX_API_KEY when base URL is MiniMax', () => {
    process.env.MINIMAX_API_KEY = 'mm-test-key';
    process.env.YOME_BASE_URL = 'https://api.minimax.io/v1';
    process.env.YOME_MODEL = 'MiniMax-M2.7';

    const config = resolveConfig({});
    expect(config.apiKey).toBe('mm-test-key');
    expect(config.provider).toBe('openai');
    expect(config.model).toBe('MiniMax-M2.7');
  });

  it('prefers explicit YOME_API_KEY over MINIMAX_API_KEY', () => {
    process.env.YOME_API_KEY = 'explicit-key';
    process.env.MINIMAX_API_KEY = 'mm-test-key';
    process.env.YOME_BASE_URL = 'https://api.minimax.io/v1';

    const config = resolveConfig({});
    expect(config.apiKey).toBe('explicit-key');
  });

  it('ignores MINIMAX_API_KEY for non-MiniMax URLs', () => {
    process.env.MINIMAX_API_KEY = 'mm-test-key';
    process.env.YOME_BASE_URL = 'https://api.openai.com/v1';

    const config = resolveConfig({});
    expect(config.apiKey).toBe('');
  });
});
