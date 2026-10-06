import { isAbsolute, join } from "node:path";
import { readdirSync } from "node:fs";
import type { ToolRegistry } from "../tools/registry.js";

/** Explicit development-only launch, requiring an existing empty dedicated home. */
export function connectionTestProfile(
  argv: readonly string[],
  packaged: boolean,
  home?: string,
) {
  if (!argv.includes("--connection-test")) return undefined;
  if (packaged || !home || !isAbsolute(home) || readdirSync(home).length)
    throw new Error(
      "Connection test requires an empty absolute development home",
    );
  return join(home, "electron-user-data");
}

/** No file, shell, network or user-data access; one execution per session. */
export function connectionTestTools(): ToolRegistry {
  let used = false;
  return new Map([
    [
      "EvalEcho",
      {
        spec: {
          name: "EvalEcho",
          description:
            "Harmless fixed evaluation tool. Pass value=seed once; returns EVAL-OK-42.",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string", enum: ["seed"] } },
            required: ["value"],
            additionalProperties: false,
          },
        },
        readOnly: true,
        async validate(input) {
          return input &&
            typeof input === "object" &&
            Object.keys(input).length === 1 &&
            (input as { value?: unknown }).value === "seed"
            ? undefined
            : "Expected fixed value=seed";
        },
        async execute(_input, signal) {
          signal.throwIfAborted();
          if (used) return { content: "Fixture already used", isError: true };
          used = true;
          return { content: "EVAL-OK-42" };
        },
      },
    ],
  ]);
}
