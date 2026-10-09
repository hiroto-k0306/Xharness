import { type BackgroundShells } from "./background-shells.js";
import { argumentsObject } from "./files.js";
import { failure, structuredFailure } from "./errors.js";
import { type ToolRegistry } from "./registry.js";

export const BACKGROUND_TOOLS = ["BashOutput", "KillShell"] as const;
export function backgroundTools(shells: BackgroundShells): ToolRegistry {
  return new Map(
    BACKGROUND_TOOLS.map((name) => {
      const validate = async (input: unknown) => {
        try {
          const a = argumentsObject(input);
          if (typeof a.shellId !== "string" || !a.shellId.trim())
            return "shellIdを指定してください。";
          if (
            Object.keys(a).some(
              (key) =>
                ![
                  "shellId",
                  ...(name === "BashOutput" ? ["wait", "timeoutSec"] : []),
                ].includes(key),
            )
          )
            return "未対応の引数です。";
          if (a.wait !== undefined && typeof a.wait !== "boolean")
            return "waitは真偽値で指定してください。";
          if (
            a.timeoutSec !== undefined &&
            (typeof a.timeoutSec !== "number" ||
              !Number.isInteger(a.timeoutSec) ||
              a.timeoutSec < 1 ||
              a.timeoutSec > 60)
          )
            return "待機は1〜60秒で指定してください。";
        } catch {
          return "引数の形式が不正です。";
        }
      };
      return [
        name,
        {
          readOnly: true,
          boundedOutput: true,
          autoAllow: true,
          endTurn: () => shells.endTurn(),
          spec: {
            name,
            description:
              name === "BashOutput"
                ? "Get unread output and status of your own background shell in this turn. wait=true waits for output or completion, at most 60 seconds (default). Output is at most 30000 characters; call again for omitted content. droppedBytes reports output discarded by the 1 MiB retention limit."
                : "Stop your own background shell and its process tree. IDs do not survive the turn.",
            inputSchema: {
              type: "object",
              properties: {
                shellId: { type: "string" },
                ...(name === "BashOutput"
                  ? {
                      wait: { type: "boolean" },
                      timeoutSec: { type: "integer", minimum: 1, maximum: 60 },
                    }
                  : {}),
              },
              required: ["shellId"],
              additionalProperties: false,
            },
          },
          validate,
          async execute(input, signal, context) {
            signal.throwIfAborted();
            const invalid = await validate(input);
            if (invalid)
              return {
                content: invalid,
                isError: true,
                error: failure("invalid_args"),
              };
            const a = argumentsObject(input);
            try {
              const result =
                name === "KillShell"
                  ? await shells.kill(String(a.shellId))
                  : await shells.output(
                      String(a.shellId),
                      signal,
                      a.wait ? Number(a.timeoutSec ?? 60) * 1000 : 0,
                      context?.redact,
                    );
              const status = result.status;
              const error =
                status === "timeout"
                  ? failure("timeout")
                  : status === "aborted"
                    ? failure("aborted")
                    : status === "failed"
                      ? failure("failed")
                      : undefined;
              return {
                content: JSON.stringify(result),
                isError: !!error,
                error,
              };
            } catch (error) {
              const detail = structuredFailure(error);
              return { content: detail.message, isError: true, error: detail };
            }
          },
        },
      ];
    }),
  );
}
