// cli/src/tools/askUser.ts
//
// `AskUser` — agent tool that pauses execution and surfaces 1–4
// multiple-choice questions in the TUI. The agent uses it to clarify
// ambiguous requirements or to let the user pick between approaches
// BEFORE doing irreversible work.
//
// Routing:
//   - In TUI mode: tools/index.ts has registered an ask-user handler
//     (App.tsx mounts it on startup); this tool awaits the user's
//     answers and returns them as JSON.
//   - In headless / SDK mode: no handler is registered — the tool
//     short-circuits with a "no UI available" answer so the agent can
//     keep going (or pick a default itself).

import type { ToolDef } from '../types.js';

// ── Handler injection ───────────────────────────────────────────────

export interface AskUserQuestion {
  /** Full question text shown to the user (should end with `?`). */
  question: string;
  /** Short chip label shown above the option list (≤ 12 chars). */
  header: string;
  /** 2–4 options. Do NOT include "Other" — the UI auto-adds a custom-answer entry. */
  options: { label: string; description?: string }[];
}

export interface AskUserResult {
  /** Map: question text → answer string (the chosen label or the user's free-text). */
  answers: Record<string, string>;
  /** True if the user pressed Esc / cancelled all questions. */
  cancelled?: boolean;
}

let _askUserFn: ((questions: AskUserQuestion[]) => Promise<AskUserResult>) | null = null;

export function setAskUserHandler(
  fn: (questions: AskUserQuestion[]) => Promise<AskUserResult>,
): void {
  _askUserFn = fn;
}

// ── Tool ─────────────────────────────────────────────────────────────

const DESCRIPTION =
  'Ask the user 1–4 multiple-choice questions during execution to clarify ambiguous ' +
  'requirements or let them pick between trade-offs. ' +
  'Each question has 2–4 options; do NOT include an "Other" option, the UI provides ' +
  'a custom-answer entry automatically. ' +
  'BLOCKING: this tool waits for the user to answer in the TUI before returning.';

export const askUserTool: ToolDef = {
  name: 'AskUser',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: '1–4 questions to ask the user (asked one at a time, in order).',
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'Full question text. Should end with `?` and be self-contained.',
            },
            header: {
              type: 'string',
              description: 'Short chip label (≤ 12 chars), e.g. "Library", "Approach".',
            },
            options: {
              type: 'array',
              description: '2–4 mutually exclusive choices. Do NOT add an "Other" option.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Concise option label (1–5 words).' },
                  description: { type: 'string', description: 'Optional one-line explanation.' },
                },
                required: ['label'],
              },
            },
          },
          required: ['question', 'header', 'options'],
        },
      },
    },
    required: ['questions'],
  },
  isReadOnly() { return true; },
  validateInput(input) {
    if (!Array.isArray(input.questions) || input.questions.length === 0) {
      return { valid: false, error: 'questions must be a non-empty array' };
    }
    if (input.questions.length > 4) {
      return { valid: false, error: `at most 4 questions per call (got ${input.questions.length})` };
    }
    const seenQuestions = new Set<string>();
    for (let i = 0; i < input.questions.length; i++) {
      const q = input.questions[i] as Partial<AskUserQuestion> | null | undefined;
      if (!q || typeof q !== 'object') {
        return { valid: false, error: `questions[${i}] must be an object` };
      }
      if (typeof q.question !== 'string' || !q.question.trim()) {
        return { valid: false, error: `questions[${i}].question must be a non-empty string` };
      }
      if (seenQuestions.has(q.question)) {
        return { valid: false, error: `duplicate question text at questions[${i}]` };
      }
      seenQuestions.add(q.question);
      if (typeof q.header !== 'string' || !q.header.trim()) {
        return { valid: false, error: `questions[${i}].header must be a non-empty string` };
      }
      if (q.header.length > 12) {
        return { valid: false, error: `questions[${i}].header must be ≤ 12 chars (got ${q.header.length})` };
      }
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
        return { valid: false, error: `questions[${i}].options must have 2–4 items` };
      }
      const seenLabels = new Set<string>();
      for (let j = 0; j < q.options.length; j++) {
        const opt = q.options[j] as { label?: unknown; description?: unknown } | undefined;
        if (!opt || typeof opt !== 'object') {
          return { valid: false, error: `questions[${i}].options[${j}] must be an object` };
        }
        if (typeof opt.label !== 'string' || !opt.label.trim()) {
          return { valid: false, error: `questions[${i}].options[${j}].label must be a non-empty string` };
        }
        if (seenLabels.has(opt.label)) {
          return { valid: false, error: `duplicate option label "${opt.label}" in questions[${i}]` };
        }
        seenLabels.add(opt.label);
      }
    }
    return { valid: true };
  },
  async execute(input) {
    const questions = input.questions as AskUserQuestion[];
    if (!_askUserFn) {
      // Headless / SDK / non-TUI host. Tell the agent there's no
      // interactive UI so it can fall back to a default.
      return JSON.stringify(
        {
          answers: {},
          cancelled: true,
          reason: 'No interactive UI is attached to this session. AskUser is unavailable here — pick a sensible default and proceed, or surface the question in your reply.',
        },
        null,
        2,
      );
    }
    const result = await _askUserFn(questions);
    return JSON.stringify(result, null, 2);
  },
};
