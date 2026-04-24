// cli/src/threadShare.ts — Build a shareable case bundle from a session.
//
// Steps (per spec 9.1):
//   1. Load all messages for <sessionId>
//   2. Run ThreadRedactor over messages and trace
//   3. Emit a directory bundle:
//        thread.json       — redacted message timeline
//        trace.json        — redacted tool_use/tool_result extracted from messages
//        fixtures.json     — sandbox-friendly initial state stub (skill-specific)
//        README.md         — human-readable summary + rule-hit table
//
// We intentionally do NOT make any network call here. The PR/fork submission
// step (spec 9.1 step 5) is a follow-up command that consumes this bundle.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSessionMessages } from './sessions.js';
import {
  DEFAULT_RULES,
  redactValue,
  totalHits,
  type RedactionRule,
  type RuleHit,
} from './redact.js';
import type { AgentMessage, ContentBlock, ToolUseBlock, ToolResultBlock } from './types.js';

export interface BuildBundleOptions {
  sessionId: string;
  /** Skill slug the bundle targets, e.g. "@yome/ppt". Goes into README. */
  skillSlug: string;
  /** Where to write the bundle directory. The dir is created (must not exist). */
  outDir: string;
  /** Override default rules. Pass [] to skip redaction entirely. */
  rules?: RedactionRule[];
}

export type BuildBundleResult =
  | { ok: true; outDir: string; messageCount: number; toolCallCount: number; hits: RuleHit[] }
  | { ok: false; reason: string };

interface TraceStep {
  index: number;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  result?: string;
}

/**
 * Walk an AgentMessage list to extract tool calls in order. Each tool_use
 * is matched with its tool_result by id (results may live in the next user
 * message per Anthropic format).
 */
function extractTrace(messages: AgentMessage[]): TraceStep[] {
  const steps: TraceStep[] = [];
  const indexById = new Map<string, number>();

  for (const msg of messages) {
    const blocks: ContentBlock[] = typeof msg.content === 'string'
      ? [{ type: 'text', text: msg.content }]
      : msg.content;
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        const tu = block as ToolUseBlock;
        const idx = steps.length;
        indexById.set(tu.id, idx);
        steps.push({ index: idx, toolUseId: tu.id, toolName: tu.name, input: tu.input });
      } else if (block.type === 'tool_result') {
        const tr = block as ToolResultBlock;
        const idx = indexById.get(tr.tool_use_id);
        if (idx !== undefined) steps[idx].result = tr.content;
      }
    }
  }
  return steps;
}

function renderReadme(opts: {
  skillSlug: string;
  sessionId: string;
  messageCount: number;
  toolCallCount: number;
  hits: RuleHit[];
}): string {
  const hitTable = opts.hits.length === 0
    ? '_No redactions applied — thread had no detectable PII / secrets / paths._'
    : [
        '| Rule | Count | Samples |',
        '| --- | ---: | --- |',
        ...opts.hits.map(h => `| \`${h.rule}\` | ${h.count} | ${h.samples.map(s => `\`${s.replace(/\|/g, '\\|')}\``).join(', ')} |`),
      ].join('\n');

  return `# Case for ${opts.skillSlug}

Generated from session \`${opts.sessionId}\` by \`yome thread share\`.

- Messages: **${opts.messageCount}**
- Tool calls: **${opts.toolCallCount}**

## Files

- \`thread.json\` — full message timeline (redacted)
- \`trace.json\` — flattened tool_use → tool_result steps (redacted)
- \`fixtures.json\` — placeholder for sandbox-replay initial state; **fill in** the skill-specific world before opening a PR

## Redaction summary

${hitTable}

## How this bundle is used

The skill's GitHub repo \`cases/<slug>/\` accepts directories like this one
as new replayable cases. Sandbox runs the skill against \`fixtures.json\`
and compares the actual trace against \`trace.json\`.

> Always re-read the redacted files yourself before opening a PR — the
> redactor is a best-effort safety net, not a guarantee.
`;
}

export function buildShareBundle(opts: BuildBundleOptions): BuildBundleResult {
  const messages = loadSessionMessages(opts.sessionId);
  if (messages.length === 0) {
    return { ok: false, reason: `session ${opts.sessionId} has no messages (or does not exist for this cwd)` };
  }

  const rules = opts.rules ?? DEFAULT_RULES;
  const trace = extractTrace(messages);

  const redactedMessagesResult = redactValue(messages, rules);
  const redactedTraceResult = redactValue(trace, rules);

  // Aggregate hits across both walks for the README.
  const hits = totalHits([redactedMessagesResult.hits, redactedTraceResult.hits]);

  try {
    mkdirSync(opts.outDir, { recursive: false });
  } catch (e) {
    return { ok: false, reason: `outDir ${opts.outDir}: ${(e as Error).message}` };
  }

  writeFileSync(
    join(opts.outDir, 'thread.json'),
    JSON.stringify({ sessionId: opts.sessionId, skill: opts.skillSlug, messages: redactedMessagesResult.redacted }, null, 2),
  );
  writeFileSync(
    join(opts.outDir, 'trace.json'),
    JSON.stringify({ sessionId: opts.sessionId, skill: opts.skillSlug, steps: redactedTraceResult.redacted }, null, 2),
  );
  writeFileSync(
    join(opts.outDir, 'fixtures.json'),
    JSON.stringify({
      $note: 'Fill in the sandbox-replay initial world for this skill before opening a PR.',
      skill: opts.skillSlug,
      skillStates: {},
    }, null, 2),
  );
  writeFileSync(
    join(opts.outDir, 'README.md'),
    renderReadme({
      skillSlug: opts.skillSlug,
      sessionId: opts.sessionId,
      messageCount: messages.length,
      toolCallCount: trace.length,
      hits,
    }),
  );

  return {
    ok: true,
    outDir: opts.outDir,
    messageCount: messages.length,
    toolCallCount: trace.length,
    hits,
  };
}
