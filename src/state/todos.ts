// cli/src/state/todos.ts
//
// Session-scope todo list. Lives in module memory only — `/new` clears
// it via clearTodos(). Mirrored to the UI through a single change
// handler (App.tsx subscribes once on mount).
//
// Why not persist to disk?
//   - Todos are an ephemeral planning aid for the current LLM turn /
//     conversation. A fresh CLI invocation legitimately starts with an
//     empty list.
//   - Cross-process sharing isn't useful here (one yome process == one
//     interactive agent session).

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  /** Imperative form, shown in the panel and used by the model. */
  content: string;
  /** Present-continuous form, shown when the item is the active step. */
  activeForm: string;
  status: TodoStatus;
}

let _currentTodos: TodoItem[] = [];
let _onChange: ((todos: TodoItem[]) => void) | null = null;

export function getTodos(): TodoItem[] {
  return _currentTodos;
}

export function setTodos(todos: TodoItem[]): void {
  // Always replace wholesale — the agent owns the list and re-sends the
  // full snapshot on every TodoWrite. This keeps the model's mental
  // model in sync with reality (no stale items can hide behind a
  // partial update).
  _currentTodos = todos;
  _onChange?.(_currentTodos);
}

export function clearTodos(): void {
  setTodos([]);
}

export function setTodosChangeHandler(fn: (todos: TodoItem[]) => void): void {
  _onChange = fn;
}
