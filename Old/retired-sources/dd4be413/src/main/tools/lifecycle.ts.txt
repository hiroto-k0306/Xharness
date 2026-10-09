import { argumentsObject } from "./files.js";
import { type Tool, type ToolRegistry } from "./registry.js";

export const LIFECYCLE_TOOLS = ["StopTask", "AskUserQuestion"] as const;

/** Stops the current agent turn; never marks an implementation complete. */
export function lifecycleTools(): ToolRegistry {
  return new Map(
    LIFECYCLE_TOOLS.map<[string, Tool]>((name) => {
      const key = name === "StopTask" ? "reason" : "question";
      const validate = async (input: unknown) => {
        try {
          const a = argumentsObject(input);
          if (
            Object.keys(a).some(
              (k) =>
                ![
                  key,
                  ...(name === "AskUserQuestion" ? ["options"] : []),
                ].includes(k),
            )
          )
            return "Unknown argument";
          if (
            typeof a[key] !== "string" ||
            !a[key].trim() ||
            a[key].length > 4000
          )
            return `${key} must be nonempty and at most 4000 characters`;
          if (
            a.options !== undefined &&
            (!Array.isArray(a.options) ||
              a.options.length < 2 ||
              a.options.length > 5 ||
              a.options.some(
                (o) => typeof o !== "string" || !o.trim() || o.length > 300,
              ))
          )
            return "options must contain 2–5 short strings";
        } catch {
          return "Invalid arguments";
        }
      };
      return [
        name,
        {
          control: true,
          readOnly: true,
          spec: {
            name,
            description:
              name === "StopTask"
                ? "Stop this agent turn with a reason and wait for new user input. Preserves changes; does not declare success or waive review. Other calls in the same response are cancelled."
                : "Ask the user a question and stop this agent turn until they send a reply. Optional suggested answers. Other calls in the same response are cancelled.",
            inputSchema: {
              type: "object",
              properties: {
                [key]: { type: "string", minLength: 1, maxLength: 4000 },
                ...(name === "AskUserQuestion"
                  ? {
                      options: {
                        type: "array",
                        minItems: 2,
                        maxItems: 5,
                        items: { type: "string", minLength: 1, maxLength: 300 },
                      },
                    }
                  : {}),
              },
              required: [key],
              additionalProperties: false,
            },
          },
          validate,
          async execute(input, signal) {
            signal.throwIfAborted();
            const invalid = await validate(input);
            if (invalid) return { content: invalid, isError: true };
            const a = argumentsObject(input);
            const message = `${name === "StopTask" ? "作業を停止しました：" : "確認が必要です："}${String(a[key])}${Array.isArray(a.options) ? "\n" + a.options.map((o, i) => `${i + 1}. ${o}`).join("\n") : ""}`;
            return {
              content: message,
              stop: {
                reason:
                  name === "StopTask"
                    ? ("agent_stopped" as const)
                    : ("awaiting_user" as const),
                message,
              },
            };
          },
        },
      ];
    }),
  );
}
