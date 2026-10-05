import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type ProviderName } from "../../shared/ipc.js";
import { resolveCli } from "../tools/environment.js";
import { powershellArguments } from "../tools/powershell-command.js";
import { type RefreshResult } from "./auto-refresh.js";

export function refreshArguments(provider: ProviderName, cwd: string) {
  const prompt = "Reply only pong. Do not use tools.";
  return provider === "claude"
    ? [
        "-p",
        prompt,
        "--model",
        "claude-haiku-4-5-20251001",
        "--safe-mode",
        "--no-session-persistence",
        "--tools",
        "",
        "--setting-sources",
        "",
      ]
    : [
        "exec",
        "--color",
        "never",
        "-m",
        "gpt-6-luna",
        "-c",
        'model_reasoning_effort="low"',
        "-c",
        'web_search="disabled"',
        "-c",
        'approval_policy="never"',
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "-C",
        cwd,
        prompt,
      ];
}
export function refreshEnvironment(): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
  ])
    delete (env as NodeJS.ProcessEnv)[key];
  return env;
}

/** Discard both output streams at spawn time, including all error text. */
export async function executeRefresh(
  provider: ProviderName,
  configuredPath?: string,
): Promise<RefreshResult["result"]> {
  let cwd: string | undefined;
  try {
    const env = refreshEnvironment();
    const executable =
      configuredPath ??
      (await resolveCli(provider, env)) ??
      (process.platform === "win32"
        ? await resolveCli(provider + ".cmd", env)
        : undefined);
    if (!executable || !isAbsolute(executable)) return "cli_missing";
    try {
      await access(executable);
    } catch {
      return "cli_missing";
    }
    let command = executable;
    cwd = await mkdtemp(join(tmpdir(), "xh-auth-refresh-"));
    let args = refreshArguments(provider, cwd);
    if (process.platform === "win32") {
      command = (await resolveCli("pwsh", env)) ?? "";
      if (!command) return "cli_missing";
      const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
      // PowerShell uses legacy native argument passing for npm .cmd shims.
      // Preserve TOML string quotes through cmd.exe and the shim's Node process.
      if (/\.(cmd|bat)$/i.test(executable))
        args = args.map((arg) => arg.replaceAll('"', '\\"'));
      args = powershellArguments(
        `& ${quote(executable)} ${args.map(quote).join(" ")}; exit $LASTEXITCODE`,
        true,
      );
    }
    return await new Promise<RefreshResult["result"]>((resolve) => {
      const child = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: "ignore",
        detached: process.platform !== "win32",
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (process.platform === "win32" && child.pid) {
          const killer = spawn(
            "taskkill",
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" },
          );
          killer.once("error", () => child.kill());
          killer.once("close", (code) => {
            if (code !== 0) child.kill();
          });
        } else if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }, 60_000);
      child.once("error", () => {
        clearTimeout(timer);
        resolve("failed");
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(timedOut ? "timeout" : code === 0 ? "success" : "failed");
      });
    });
  } catch {
    return "failed";
  } finally {
    if (cwd)
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}
