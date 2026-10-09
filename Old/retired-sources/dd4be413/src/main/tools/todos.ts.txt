import { parseTodos } from "../../shared/todos.js";
import { failure } from "./errors.js";
import { type ToolRegistry } from "./registry.js";

const invalid =
  "todosは配列で、各項目には空でないcontentとpending・in_progress・completedのいずれかのstatusが必要です。";

/** Pure replacement snapshot; each agent's own tool history is its state. */
export function todoTools(): ToolRegistry {
  return new Map([
    [
      "TodoWrite",
      {
        readOnly: true,
        autoAllow: true,
        spec: {
          name: "TodoWrite",
          description:
            "Replace your entire lightweight progress list. Include all items on each update; use an empty list to clear. Keep at most one item in_progress (multiple are accepted). Independent of SubmitPlan and workflow/review completion. Only updates this agent's list; no file changes.",
          inputSchema: {
            type: "object",
            properties: {
              todos: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    content: { type: "string", minLength: 1 },
                    status: {
                      type: "string",
                      enum: ["pending", "in_progress", "completed"],
                    },
                  },
                  required: ["content", "status"],
                },
              },
            },
            required: ["todos"],
          },
        },
        validate: async (input) => (parseTodos(input) ? undefined : invalid),
        async execute(input, signal) {
          signal.throwIfAborted();
          const todos = parseTodos(input);
          if (!todos)
            return {
              content: invalid,
              isError: true,
              error: { ...failure("invalid_args"), message: invalid },
            };
          return {
            content: `進捗リストを置き換えました（${todos.length}件、完了${todos.filter((t) => t.status === "completed").length}件）。`,
          };
        },
      },
    ],
  ]);
}
