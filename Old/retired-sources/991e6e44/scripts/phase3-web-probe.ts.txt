/** Explicit live probe only. Normal tests never invoke this entry point. */
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readCodexCredentials } from "../src/main/auth/codex-oauth.js";
import { readClaudeAccessToken } from "../src/main/auth/claude-oauth.js";
import { readSse } from "../src/main/providers/sse.js";
import { claudeIdentity } from "../src/main/providers/claude/convert.js";
import { record } from "../spike/lib/record.js";
import { inspectHeaders } from "../spike/lib/headers.js";
import { type ProviderId } from "../src/main/core/types.js";

async function reserve(provider: ProviderId, name: string) {
  const dir = join(".out", "phase3-budget", provider);
  await mkdir(dir, { recursive: true });
  for (let count = 1; count <= (provider === "codex" ? 12 : 7); count++) {
    let file;
    try {
      file = await open(join(dir, `${count}.json`), "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new Error("Phase 3 budget unavailable");
    }
    try {
      await file.writeFile(
        JSON.stringify({ name, at: new Date().toISOString() }) + "\n",
      );
    } finally {
      await file.close();
    }
    return count;
  }
  throw new Error("Phase 3 API budget exhausted");
}
async function send(
  provider: ProviderId,
  name: string,
  headers: Headers,
  body: unknown,
  secrets: string[],
) {
  const count = await reserve(provider, name);
  const response = await fetch(
    provider === "codex"
      ? "https://chatgpt.com/backend-api/codex/responses"
      : "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(55000),
    },
  );
  const events: { event: string; data: string }[] = [];
  let errorBody: unknown;
  if (response.ok)
    for await (const event of readSse(response)) events.push(event);
  else errorBody = await response.text();
  const paths = await record(
    provider,
    name,
    {
      requestHeaders: headers,
      requestBody: body,
      responseHeaders: response.headers,
      status: response.status,
      events,
      body: errorBody,
    },
    { secrets },
  );
  const data = events.map((e) => JSON.parse(e.data) as Record<string, unknown>);
  const tools = data.flatMap((e) => {
    const item = (e.item ?? e.content_block) as
      Record<string, unknown> | undefined;
    return item ? [item] : [];
  });
  const searched =
    provider === "codex"
      ? tools.some(
          (i) => i.type === "web_search_call" && i.status === "completed",
        )
      : tools.some(
          (i) =>
            i.type === "web_search_tool_result" &&
            Array.isArray(i.content) &&
            i.content.some(
              (c) => (c as { type?: string }).type === "web_search_result",
            ),
        );
  return {
    provider,
    name,
    count,
    status: response.status,
    searched,
    toolTypes: [...new Set(tools.map((i) => i.type))],
    usage: inspectHeaders(response.headers, secrets).usage,
    fixture: paths.fixture,
    completed: data.some(
      (e) => e.type === "response.completed" || e.type === "message_stop",
    ),
  };
}
const provider = process.argv[2] as ProviderId;
const reports: unknown[] = [];
try {
  if (provider === "codex") {
    const auth = await readCodexCredentials();
    const id = randomUUID();
    const headers = new Headers({
      authorization: `Bearer ${auth.accessToken}`,
      "chatgpt-account-id": auth.accountId,
      originator: "codex_cli_rs",
      "user-agent": "codex_cli_rs/0.159.2",
      "session-id": id,
      "thread-id": id,
      "x-client-request-id": id,
      "content-type": "application/json",
      accept: "text/event-stream",
    });
    const body = (search: boolean) => ({
      model: "gpt-6-luna",
      instructions: "Be concise. Search no more than once.",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: search
                ? "Use web search exactly once to find the official Node.js website. Reply only with its URL."
                : "Reply only pong.",
            },
          ],
        },
      ],
      tools: search ? [{ type: "web_search", external_web_access: true }] : [],
      tool_choice: "auto",
      reasoning: { effort: "low" },
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    });
    reports.push(
      await send(provider, "phase3-web-baseline", headers, body(false), [
        auth.accessToken,
        auth.accountId,
      ]),
    );
    reports.push(
      await send(provider, "phase3-web-live", headers, body(true), [
        auth.accessToken,
        auth.accountId,
      ]),
    );
  } else if (provider === "claude") {
    const token = await readClaudeAccessToken();
    const headers = new Headers({
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });
    const body = (search: boolean, model = "claude-haiku-4-5-20251001") => ({
      model,
      system: [
        { type: "text", text: claudeIdentity },
        { type: "text", text: "Be concise. Search no more than once." },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: search
                ? "Use web search exactly once to find the official Node.js website. Reply only with its URL."
                : "Reply only pong.",
            },
          ],
        },
      ],
      max_tokens: 1024,
      stream: true,
      ...(search
        ? {
            tools: [
              { type: "web_search_20250305", name: "web_search", max_uses: 1 },
            ],
            tool_choice: { type: "auto" },
          }
        : {}),
    });
    reports.push(
      await send(provider, "phase3-web-baseline", headers, body(false), [
        token,
      ]),
    );
    const search = await send(
      provider,
      "phase3-web-haiku",
      headers,
      body(true),
      [token],
    );
    reports.push(search);
    if (
      !search.searched &&
      search.status !== 401 &&
      search.status !== 403 &&
      search.status !== 429
    )
      reports.push(
        await send(
          provider,
          "phase3-web-sonnet",
          headers,
          {
            ...body(true, "claude-sonnet-5-5"),
            output_config: { effort: "high" },
          },
          [token],
        ),
      );
  } else throw new Error("Specify codex or claude");
} catch {
  reports.push({
    provider,
    error:
      "Probe stopped; check credentials with the official CLI or inspect masked fixtures",
  });
}
await mkdir(".out", { recursive: true });
await writeFile(
  `.out/phase3-${provider}-web-report.json`,
  JSON.stringify(reports, null, 2) + "\n",
);
process.stdout.write(JSON.stringify(reports) + "\n");
