import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { argumentsObject, stringArg } from "./files.js";
import { runProcess } from "./process.js";
import { type ToolRegistry } from "./registry.js";

export function shellSearchTools(cwd: string): ToolRegistry {
  const result: ToolRegistry = new Map();
  for (const name of ["Bash", "Grep", "Glob"] as const) {
    const properties =
      name === "Bash"
        ? {
            command: { type: "string" },
            timeoutSec: { type: "integer", minimum: 1, maximum: 600 },
          }
        : { pattern: { type: "string" }, path: { type: "string" } };
    const required = [name === "Bash" ? "command" : "pattern"];
    const validate = async (input: unknown) => {
      try {
        const args = argumentsObject(input);
        if (Object.keys(args).some((k) => !Object.keys(properties).includes(k)))
          return "Unknown argument";
        if (!stringArg(args, required[0]!).trim())
          return "Command or pattern is empty";
        if (args.path !== undefined) stringArg(args, "path");
        if (
          args.timeoutSec !== undefined &&
          (typeof args.timeoutSec !== "number" ||
            !Number.isInteger(args.timeoutSec) ||
            args.timeoutSec < 1 ||
            args.timeoutSec > 600)
        )
          return "timeoutSec must be 1–600";
        if (!(await stat(cwd)).isDirectory()) return "Workspace is unavailable";
      } catch {
        return "Invalid arguments or unavailable workspace";
      }
    };
    result.set(name, {
      spec: {
        name,
        description:
          name === "Bash"
            ? "Run a command in PowerShell 7; default timeout 120 seconds, maximum 600"
            : name === "Grep"
              ? "Search file contents with ripgrep regular expressions"
              : "List files matching a ripgrep glob",
        inputSchema: {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        },
      },
      readOnly: name !== "Bash",
      validate,
      async execute(input, signal) {
        const error = await validate(input);
        if (error) return { content: error, isError: true };
        const args = argumentsObject(input);
        let execution;
        if (name === "Bash") {
          const encoded = Buffer.from(
            stringArg(args, "command"),
            "utf16le",
          ).toString("base64");
          execution = await runProcess(
            "pwsh",
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              encoded,
            ],
            cwd,
            signal,
            Number(args.timeoutSec ?? 120) * 1000,
          );
        } else {
          const directory = resolve(
            cwd,
            typeof args.path === "string" ? args.path : ".",
          );
          const excludes = [
            "--glob",
            "!auth.json",
            "--glob",
            "!*.credentials.json",
            "--glob",
            "!.git/**",
          ];
          const parameters =
            name === "Glob"
              ? [
                  "--files",
                  ...excludes,
                  "--glob",
                  stringArg(args, "pattern"),
                  "--",
                  directory,
                ]
              : [
                  "--line-number",
                  "--no-heading",
                  "--color",
                  "never",
                  ...excludes,
                  "--",
                  stringArg(args, "pattern"),
                  directory,
                ];
          execution = await runProcess("rg", parameters, cwd, signal, 120000);
          // ripgrep exit 1 means no matches, not a failed search.
          if (execution.exitCode === 1 && !execution.stopped)
            execution.isError = false;
        }
        return {
          content: JSON.stringify({
            completedAt: new Date().toISOString(),
            output: execution.output,
          }),
          isError: execution.isError,
        };
      },
    });
  }
  return result;
}
