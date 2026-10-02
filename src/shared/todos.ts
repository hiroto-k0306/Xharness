export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** Shared validation for the tool and history/UI; no item or text limits. */
export function parseTodos(input: unknown): Todo[] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return;
  if (
    todos.some(
      (todo) =>
        !todo ||
        typeof todo !== "object" ||
        Array.isArray(todo) ||
        typeof todo.content !== "string" ||
        !todo.content.trim() ||
        !["pending", "in_progress", "completed"].includes(todo.status),
    )
  )
    return;
  return todos.map(({ content, status }) => ({ content, status }));
}
