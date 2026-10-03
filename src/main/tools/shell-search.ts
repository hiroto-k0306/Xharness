import { stat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { argumentsObject, stringArg } from "./files.js";
import { runProcess } from "./process.js";
import { type ToolRegistry } from "./registry.js";
import { cliAvailable } from "./environment.js";
import { nodeSearch, searchExcluded } from "./node-search.js";
import { failure, structuredFailure, ToolExecutionError } from "./errors.js";
import { BackgroundShells } from "./background-shells.js";
import { backgroundTools } from "./background-tools.js";
import { powershellArguments } from "./powershell-command.js";

export function shellSearchTools(cwd: string): ToolRegistry {
  const shells = new BackgroundShells();
  const endTurn = () => shells.endTurn();
  const result: ToolRegistry = new Map();
  for (const name of ["Bash", "Grep", "Glob"] as const) {
    const properties =
      name === "Bash"
        ? {
            command: { type: "string" },
            timeoutSec: { type: "integer", minimum: 1, maximum: 600 },
            run_in_background: { type: "boolean" },
          }
        : { pattern: { type: "string" }, path: { type: "string" } };
    const required = [name === "Bash" ? "command" : "pattern"];
    const validate = async (input: unknown) => {
      try {
        const args = argumentsObject(input);
        if (Object.keys(args).some((k) => !Object.keys(properties).includes(k)))
          return "未対応の引数です。";
        if (!stringArg(args, required[0]!).trim())
          return "コマンドまたは検索パターンを指定してください。";
        if (args.path !== undefined) stringArg(args, "path");
        if (
          args.run_in_background !== undefined &&
          typeof args.run_in_background !== "boolean"
        )
          return "run_in_backgroundは真偽値で指定してください。";
        if (
          args.timeoutSec !== undefined &&
          (typeof args.timeoutSec !== "number" ||
            !Number.isInteger(args.timeoutSec) ||
            args.timeoutSec < 1 ||
            args.timeoutSec > 600)
        )
          return "timeoutSecは1〜600秒で指定してください。";
      } catch {
        return "引数の形式が不正です。";
      }
    };
    result.set(name, {
      spec: {
        name,
        description:
          name === "Bash"
            ? "Run a command in PowerShell 7; foreground default timeout 120 seconds, maximum 600. run_in_background=true returns a shellId immediately (at most 5 running); use BashOutput/KillShell. Backgrounds end with this agent turn; timeoutSec optionally limits their lifetime. On Windows, launch children with unqualified Start-Process (including -WindowStyle Hidden), which registers them in our Job. Direct Process.Start, module-qualified Start-Process, overwritten functions, external brokers, or descendants born before registration can bypass tracking; do not use those for background children because cleanup is not guaranteed."
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
      ...(name === "Bash" ? { endTurn } : {}),
      validate,
      async execute(input, signal) {
        const error = await validate(input);
        if (error)
          return {
            content: failure("invalid_args").message,
            isError: true,
            error: failure("invalid_args"),
          };
        const args = argumentsObject(input);
        try {
          signal.throwIfAborted();
          if (!(await stat(cwd)).isDirectory())
            throw new ToolExecutionError(
              failure("not_found").message,
              "not_found",
            );
          let execution;
          if (name === "Bash") {
            if (!(await cliAvailable("pwsh")))
              throw new ToolExecutionError(
                "PowerShell 7（pwsh）が見つかりません。インストールしてアプリを再起動してください。",
                "missing_cli",
              );
            const parameters = powershellArguments(
              stringArg(args, "command"),
              !!args.run_in_background,
            );
            if (args.run_in_background)
              return {
                content: JSON.stringify(
                  await shells.start(
                    "pwsh",
                    parameters,
                    cwd,
                    signal,
                    args.timeoutSec !== undefined
                      ? Number(args.timeoutSec) * 1000
                      : undefined,
                  ),
                ),
                isError: false,
              };
            execution = await runProcess(
              "pwsh",
              parameters,
              cwd,
              signal,
              Number(args.timeoutSec ?? 120) * 1000,
            );
          } else {
            const directory = resolve(
              cwd,
              typeof args.path === "string" ? args.path : ".",
            );
            if (searchExcluded(await realpath(directory)))
              throw new ToolExecutionError(
                "資格情報や秘密ファイルは検索できません。",
                "denied",
              );
            if (!(await cliAvailable("rg")))
              return {
                content: JSON.stringify({
                  completedAt: new Date().toISOString(),
                  output: await nodeSearch(
                    cwd,
                    directory,
                    stringArg(args, "pattern"),
                    name,
                    signal,
                  ),
                  engine: "node",
                }),
                isError: false,
              };
            await stat(directory);
            const excludes = [
              "--glob",
              "!auth.json",
              "--glob",
              "!*.credentials.json",
              "--glob",
              "!.git/**",
              "--glob",
              "!.env*",
              "--glob",
              "!id_rsa",
              "--glob",
              "!id_ed25519",
              "--glob",
              "!*.pem",
              "--glob",
              "!*.key",
              "--glob",
              "!.npmrc",
              "--glob",
              "!.netrc",
              "--glob",
              "!.git-credentials",
            ];
            const parameters =
              name === "Glob"
                ? [
                    "--files",
                    "--no-require-git",
                    ...excludes,
                    "--glob",
                    stringArg(args, "pattern"),
                    "--",
                    directory,
                  ]
                : [
                    "--line-number",
                    "--no-require-git",
                    "--no-heading",
                    "--color",
                    "never",
                    ...excludes,
                    "--",
                    stringArg(args, "pattern"),
                    directory,
                  ];
            execution = await runProcess("rg", parameters, cwd, signal, 120000);
            if (execution.exitCode === 2 && !execution.stopped)
              execution.errorKind = "failed";
            // ripgrep exit 1 means no matches, not a failed search.
            if (execution.exitCode === 1 && !execution.stopped) {
              execution.isError = false;
              execution.errorKind = undefined;
            }
            if (name === "Grep" && !execution.isError) {
              const lines = execution.output.trimEnd().split(/\r?\n/);
              if (lines.length > 250)
                execution.output =
                  lines.slice(0, 250).join("\n") +
                  "\n検索結果を250件で打ち切りました。対象やパターンを絞ってください。";
            }
          }
          return {
            content: JSON.stringify({
              completedAt: new Date().toISOString(),
              output: execution.output,
            }),
            isError: execution.isError,
            error: execution.isError
              ? failure(execution.errorKind ?? "failed")
              : undefined,
          };
        } catch (error) {
          const detail = signal.aborted
            ? failure("aborted")
            : structuredFailure(error);
          return { content: detail.message, isError: true, error: detail };
        }
      },
    });
  }
  for (const [name, tool] of backgroundTools(shells))
    result.set(name, { ...tool, endTurn });
  return result;
}
