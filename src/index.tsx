import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { App } from './ui/App.js';
import { resolveConfig, saveStoredConfig, CONFIG_PATH } from './config.js';

const cli = meow(
  `
  Usage
    $ yome [prompt]

  Options
    --key, -k       Set API key (saved to ~/.yome/config.json)
    --base-url, -b  Set API base URL (saved to ~/.yome/config.json)
    --model, -m     Set model name
    --provider, -p  API provider: "anthropic" or "openai" (auto-detected from base URL)

  Environment Variables
    YOME_API_KEY    API key
    YOME_BASE_URL   API base URL (default: https://zenmux.ai/api)
    YOME_MODEL      Model name
    YOME_PROVIDER   API provider: "anthropic" or "openai"

  Examples
    $ yome "help me read package.json"
    $ yome --key sk-xxx --base-url https://api.anthropic.com
    $ yome --base-url https://dashscope.aliyuncs.com/compatible-mode/v1 --provider openai --model qwen-plus
    $ yome
`,
  {
    importMeta: import.meta,
    flags: {
      key: { type: 'string', shortFlag: 'k' },
      baseUrl: { type: 'string', shortFlag: 'b' },
      model: { type: 'string', shortFlag: 'm' },
      provider: { type: 'string', shortFlag: 'p' },
    },
  },
);

// Persist config flags
if (cli.flags.key || cli.flags.baseUrl || cli.flags.provider) {
  const updates: Record<string, string> = {};
  if (cli.flags.key) updates.apiKey = cli.flags.key;
  if (cli.flags.baseUrl) updates.baseUrl = cli.flags.baseUrl;
  if (cli.flags.model) updates.model = cli.flags.model;
  if (cli.flags.provider) updates.provider = cli.flags.provider;
  saveStoredConfig(updates);
  console.log(`Config saved to ${CONFIG_PATH}`);
  if (!cli.input.length) process.exit(0);
}

const config = resolveConfig(cli.flags);

if (!config.apiKey) {
  console.error('No API key found.');
  console.error('Set via: yome --key sk-xxx');
  console.error('Or set YOME_API_KEY environment variable.');
  process.exit(1);
}

const initialPrompt = cli.input.join(' ') || undefined;

// Pass initial prompt through config (avoids extra prop drilling)
const appConfig = initialPrompt
  ? Object.assign({}, config, { __initialPrompt: initialPrompt })
  : config;

render(<App config={appConfig} />);
