import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { credentialPath } from "./credentials.js";
import { reserveRequest } from "./budget.js";

type Snapshot = {
  access?: string;
  refresh?: string;
  expiresAt?: number;
  lastRefresh?: string;
};
async function snapshot(provider: "claude" | "codex"): Promise<Snapshot> {
  const value = JSON.parse(
    await readFile(credentialPath(provider), "utf8"),
  ) as {
    claudeAiOauth?: {
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
    };
    tokens?: { access_token?: string; refresh_token?: string };
    last_refresh?: string;
  };
  return provider === "claude"
    ? {
        access: value.claudeAiOauth?.accessToken,
        refresh: value.claudeAiOauth?.refreshToken,
        expiresAt: value.claudeAiOauth?.expiresAt,
      }
    : {
        access: value.tokens?.access_token,
        refresh: value.tokens?.refresh_token,
        lastRefresh: value.last_refresh,
      };
}

export async function probeCliRefresh(
  provider: "claude" | "codex",
  executable: string,
) {
  const before = await snapshot(provider);
  if (typeof before.access !== "string" || !before.access)
    throw new Error("OAuth credential unavailable");
  const requestNumber = await reserveRequest(provider, "cli-refresh");
  const cwd = resolve("spike/.out/cli-work");
  await mkdir(cwd, { recursive: true });
  const prompt = "Reply with the single word: pong. Do not use tools.";
  const args =
    provider === "claude"
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
          "--output-format",
          "json",
        ]
      : [
          "exec",
          "--json",
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (provider === "claude") {
    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ])
      delete env[key];
  }
  if (provider === "codex") delete env.OPENAI_API_KEY;
  const run = await new Promise<{
    exitCode: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  }>((done) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      done({ exitCode: null, timedOut, stdout: "", stderr: "" });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      done({ exitCode, timedOut, stdout, stderr });
    });
  });
  const after = await snapshot(provider);
  // CLI output can contain account data. Retain only fixed classifications.
  let pong = false;
  try {
    if (provider === "claude") {
      const data = JSON.parse(run.stdout) as {
        result?: unknown;
        is_error?: boolean;
      };
      pong =
        !data.is_error &&
        typeof data.result === "string" &&
        data.result.trim().toLowerCase() === "pong";
    } else {
      pong = run.stdout.split(/\r?\n/).some((line) => {
        try {
          const data = JSON.parse(line) as {
            type?: string;
            item?: { type?: string; text?: string };
          };
          return (
            data.type === "item.completed" &&
            data.item?.type === "agent_message" &&
            data.item.text?.trim().toLowerCase() === "pong"
          );
        } catch {
          return false;
        }
      });
    }
  } catch {
    /* No raw output is persisted. */
  }
  const observation = {
    provider,
    observedAt: new Date().toISOString(),
    requestNumber,
    cliInvocationCount: 1,
    internalHttpRequestCount: "not_observed",
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    pong,
    accessTokenChanged: before.access !== after.access,
    refreshTokenChanged: before.refresh !== after.refresh,
    expiryBefore: before.expiresAt,
    expiryAfter: after.expiresAt,
    lastRefreshChanged: before.lastRefresh !== after.lastRefresh,
    stderrPresent: run.stderr.length > 0,
    failureCategory:
      run.exitCode === 0
        ? undefined
        : /could not find home directory/i.test(run.stderr)
          ? "home_directory_unavailable"
          : /unexpected argument|unrecognized|invalid|configuration|config/i.test(
                run.stderr,
              )
            ? "configuration_error"
            : /401|authentication|unauthorized|refresh/i.test(run.stderr)
              ? "authentication_error"
              : /429|rate.?limit/i.test(run.stderr)
                ? "rate_limit"
                : "unknown_cli_error",
  };
  const path = resolve(`test/fixtures/${provider}/cli-refresh.json`);
  await writeFile(path, JSON.stringify(observation, null, 2) + "\n", "utf8");
  await writeFile(
    resolve(
      `spike/.out/${new Date().toISOString().replace(/[:.]/g, "-")}-${provider}-cli-refresh.json`,
    ),
    JSON.stringify(observation, null, 2) + "\n",
    { encoding: "utf8", flag: "wx" },
  );
  return { ...observation, path };
}
