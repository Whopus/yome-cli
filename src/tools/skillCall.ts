// cli/src/tools/skillCall.ts
//
// `SkillCall` — agent tool that invokes an action on an installed yome
// hub skill. This is the only correct way for the LLM to use hub skills;
// it must NOT try to map them to ad-hoc shell commands like
// `yome ppt new` (the model used to do that — `Bash(yome ppt new)`
// always fails since there's no such CLI subcommand).
//
// Input shape (kept minimal so the system prompt can teach it cheaply):
//
//   {
//     "slug":        "@yome/ppt",
//     "action":      "new",
//     "positionals": ["/Users/me/Desktop/hello.pptx"],
//     "flags":       { "force": true }
//   }
//
// Output is the dispatcher's stdout (or stderr prefixed with "ERROR:").

import type { ToolDef } from '../types.js';
import { invokeSkill } from '../yomeSkills/invoke.js';

export const skillCallTool: ToolDef = {
  name: 'SkillCall',
  description:
    'Invoke an action on an installed yome hub skill. ' +
    'Use this whenever the user asks to do something that an installed skill (`yome skill list`) supports — ' +
    'for example creating/editing a PowerPoint with @yome/ppt. ' +
    'Do NOT shell out to commands like "yome ppt new" — those do not exist; only this tool dispatches skills.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description: 'Skill slug like "@yome/ppt", or just the domain like "ppt".',
      },
      action: {
        type: 'string',
        description:
          'Action name from the skill\'s command list (e.g. "new", "open", "slide.add", "title", "save", "export").',
      },
      positionals: {
        type: 'array',
        items: { type: 'string' },
        description: 'Positional arguments. For ppt.new this is the .pptx path.',
      },
      flags: {
        type: 'object',
        description: 'Named flags. Values are strings, numbers, or booleans.',
      },
    },
    required: ['slug', 'action'],
  },

  isReadOnly: () => false,

  validateInput(input) {
    if (typeof input.slug !== 'string' || input.slug.length === 0) {
      return { valid: false, error: 'slug must be a non-empty string' };
    }
    if (typeof input.action !== 'string' || input.action.length === 0) {
      return { valid: false, error: 'action must be a non-empty string' };
    }
    if (input.positionals !== undefined && !Array.isArray(input.positionals)) {
      return { valid: false, error: 'positionals must be an array of strings' };
    }
    if (input.flags !== undefined && (typeof input.flags !== 'object' || Array.isArray(input.flags))) {
      return { valid: false, error: 'flags must be an object' };
    }
    return { valid: true };
  },

  async execute(input) {
    const slug = String(input.slug);
    const action = String(input.action);
    const positionals = (input.positionals as string[] | undefined) ?? [];
    const flags = (input.flags as Record<string, string | number | boolean | undefined> | undefined) ?? {};

    const r = await invokeSkill({ slugOrDomain: slug, action, positionals, flags });
    if (!r.ok) {
      return `ERROR (exit ${r.exitCode}): ${r.stderr || '(no stderr)'}`;
    }
    return r.stdout || '(no output)';
  },
};
