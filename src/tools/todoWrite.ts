// cli/src/tools/todoWrite.ts
//
// `TodoWrite` — agent tool that creates / updates a session-scope task
// checklist. Mirrors Claude Code's TodoWriteTool semantics:
//   - the agent always submits the FULL list (replacement, not patch)
//   - exactly one item should be in_progress at a time (validated)
//   - each item carries both `content` (imperative) and `activeForm`
//     (present continuous) so the UI can show "Doing X" naturally
//
// State lives in cli/src/state/todos.ts; the UI subscribes to it.

import type { ToolDef, PermissionResult } from '../types.js';
import { setTodos, type TodoItem, type TodoStatus } from '../state/todos.js';

const VALID_STATUS: ReadonlySet<TodoStatus> = new Set(['pending', 'in_progress', 'completed']);

const PROMPT = `Use this tool to create and maintain a structured checklist for the current task. It helps you organize multi-step work, demonstrate progress to the user, and avoid losing track of follow-ups discovered along the way.

## When to use
1. Multi-step work — 3 or more distinct actions
2. Non-trivial tasks that need planning or several operations
3. The user explicitly asks for a todo list, OR provides several tasks at once
4. Right after receiving a fresh batch of instructions — capture them as todos
5. The MOMENT you start working on an item — flip it to in_progress BEFORE you begin
6. The MOMENT you finish an item — flip it to completed; don't batch completions
7. When new follow-ups appear during implementation — add them

## When NOT to use
1. Single, trivial task
2. Less than 3 meaningful steps
3. Pure conversation / Q&A
If only one obvious step is needed, just do it.

## Status discipline
- pending     — not started
- in_progress — exactly ONE item should be in_progress at any time
- completed   — only when fully verified (tests pass, files saved, command succeeded)

If something is blocked, KEEP it in_progress and add a new item describing the blocker. Never mark something completed when there's an unresolved error.

## Field shape
Every item must have:
- content    : imperative form, e.g. "Run the tests"
- activeForm : present continuous, e.g. "Running the tests"
- status     : "pending" | "in_progress" | "completed"

## Submission
You always send the COMPLETE list, not a patch. The previous list is replaced.
`;

const DESCRIPTION =
  'Update the todo list for the current session. Use proactively for any task with 3+ steps. ' +
  'Always submit the FULL list (replacement, not patch). Keep exactly one item in_progress at a time. ' +
  'Each item needs `content` (imperative), `activeForm` (present continuous), and `status` ' +
  '("pending" | "in_progress" | "completed").';

export const todoWriteTool: ToolDef = {
  name: 'TodoWrite',
  description: DESCRIPTION + '\n\n' + PROMPT,
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete updated todo list (replaces the previous list).',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Imperative form, e.g. "Run the tests".',
            },
            activeForm: {
              type: 'string',
              description: 'Present continuous form, e.g. "Running the tests".',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Current state of the todo item.',
            },
          },
          required: ['content', 'activeForm', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  isReadOnly() { return false; },
  // TodoWrite mutates session-scope memory only — no files, no shell, no
  // network. There's nothing to ask the user about; auto-allow so the
  // panel updates instantly without an approval prompt.
  checkPermissions(): PermissionResult {
    return { behavior: 'allow' };
  },
  validateInput(input) {
    if (!Array.isArray(input.todos)) {
      return { valid: false, error: 'todos must be an array' };
    }
    let inProgressCount = 0;
    for (let i = 0; i < input.todos.length; i++) {
      const t = input.todos[i] as Partial<TodoItem> | null | undefined;
      if (!t || typeof t !== 'object') {
        return { valid: false, error: `todos[${i}] must be an object` };
      }
      if (typeof t.content !== 'string' || !t.content.trim()) {
        return { valid: false, error: `todos[${i}].content must be a non-empty string` };
      }
      if (typeof t.activeForm !== 'string' || !t.activeForm.trim()) {
        return { valid: false, error: `todos[${i}].activeForm must be a non-empty string` };
      }
      if (typeof t.status !== 'string' || !VALID_STATUS.has(t.status as TodoStatus)) {
        return {
          valid: false,
          error: `todos[${i}].status must be one of: pending, in_progress, completed`,
        };
      }
      if (t.status === 'in_progress') inProgressCount++;
    }
    if (inProgressCount > 1) {
      return {
        valid: false,
        error: `at most one todo may be in_progress at a time (got ${inProgressCount})`,
      };
    }
    return { valid: true };
  },
  async execute(input) {
    const todos = (input.todos as TodoItem[]).map((t) => ({
      content: t.content.trim(),
      activeForm: t.activeForm.trim(),
      status: t.status,
    }));
    const allDone = todos.length > 0 && todos.every((t) => t.status === 'completed');
    // When every item is done, drop the panel entirely (mirrors Claude
    // Code's behaviour: a completed list has no further signal value
    // and just adds visual noise above the next prompt). The agent is
    // expected to write its final summary right after — the empty space
    // gets reused immediately.
    setTodos(allDone ? [] : todos);
    if (allDone) {
      return 'All todos completed — the task list has been cleared. Write your final summary now (or add follow-up items if work remains).';
    }
    return 'Todos updated. Keep working through the in_progress item; flip status as soon as it ships or as soon as a new step starts.';
  },
};
