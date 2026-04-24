import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { App } from './ui/App.js';
import { resolveConfig, saveStoredConfig, CONFIG_PATH } from './config.js';
import { runSkillSubcommand, runLogin, runLogout, runWhoami } from './yomeSkills/cli.js';
import { runThreadSubcommand } from './threadCli.js';

const cli = meow(
  `
  Usage
    $ yome [prompt]
    $ yome skill <subcommand>
    $ yome thread <subcommand>

  Skill Subcommands
    $ yome skill install <source>   Install a skill. <source> can be:
                                      - local dir
                                      - github:owner/repo[@ref][#subpath]
                                      - https://github.com/owner/repo
    $ yome skill uninstall <slug>   Uninstall an installed skill (e.g. @yome/ppt)
    $ yome skill list               List installed skills

  Thread Subcommands
    $ yome thread list                            List sessions in the current cwd
    $ yome thread share <session-id> --skill=<slug>
                                    Build a redacted case bundle from a session
    $ yome thread submit <bundle-dir> --skill=<slug>
                                    Push an existing bundle as a PR (uses gh CLI)

  Options
    --key, -k       Set API key (saved to ~/.yome/config.json)
    --base-url, -b  Set API base URL (saved to ~/.yome/config.json)
    --model, -m     Set model name
    --provider, -p  API provider: "anthropic" or "openai" (auto-detected from base URL)
    --force         (skill install) Overwrite an existing install
    --verbose       (skill install / thread submit) Print every shelled command
    --skill         (thread share/submit) Skill slug, e.g. @yome/ppt
    --out           (thread share) Output directory (default ~/.yome/shares/...)
    --no-redact     (thread share) Disable default redactor (NOT recommended)
    --submit        (thread share) Open a PR right after building the bundle
    --case-id       (thread share/submit) Override cases/<domain>/<id>/ name
    --dry-run       (thread submit) Prepare commit but skip git push + gh pr create

  Environment Variables
    YOME_API_KEY    API key
    YOME_BASE_URL   API base URL (default: https://zenmux.ai/api)
    YOME_MODEL      Model name
    YOME_PROVIDER   API provider: "anthropic" or "openai"

  Examples
    $ yome "help me read package.json"
    $ yome skill install ./skills/yome-skill-ppt
    $ yome skill list
    $ yome skill uninstall @yome/ppt
`,
  {
    importMeta: import.meta,
    flags: {
      key: { type: 'string', shortFlag: 'k' },
      baseUrl: { type: 'string', shortFlag: 'b' },
      model: { type: 'string', shortFlag: 'm' },
      provider: { type: 'string', shortFlag: 'p' },
      force: { type: 'boolean' },
      verbose: { type: 'boolean' },
      skill: { type: 'string' },
      out: { type: 'string' },
      noRedact: { type: 'boolean' },
      submit: { type: 'boolean' },
      caseId: { type: 'string' },
      dryRun: { type: 'boolean' },
      json: { type: 'boolean' },
      yes: { type: 'boolean', shortFlag: 'y' },
      grant: { type: 'string' },
      revoke: { type: 'string' },
    },
  },
);

// Subcommand router (kept as plain dispatch — meow doesn't do nested commands).
// If/when we have ≥5 subcommands, switch to citty per spec 11.4 plan.
if (cli.input[0] === 'skill') {
  const exit = await runSkillSubcommand(cli.input.slice(1), {
    force: !!cli.flags.force,
    verbose: !!cli.flags.verbose,
    json: !!cli.flags.json,
    yes: !!cli.flags.yes,
    grant: cli.flags.grant,
    revoke: cli.flags.revoke,
  });
  process.exit(exit);
}

// Top-level auth commands (`yome login` / `logout` / `whoami`)
if (cli.input[0] === 'login')  { process.exit(await runLogin()); }
if (cli.input[0] === 'logout') { process.exit(await runLogout()); }
if (cli.input[0] === 'whoami') { process.exit(await runWhoami()); }

if (cli.input[0] === 'thread') {
  const exit = await runThreadSubcommand(cli.input.slice(1), {
    skill: cli.flags.skill,
    out: cli.flags.out,
    noRedact: !!cli.flags.noRedact,
    submit: !!cli.flags.submit,
    caseId: cli.flags.caseId,
    dryRun: !!cli.flags.dryRun,
    verbose: !!cli.flags.verbose,
  });
  process.exit(exit);
}

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
