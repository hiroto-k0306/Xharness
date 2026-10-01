import { randomUUID } from "node:crypto";
import { loadCodexAuth } from "../lib/oauth.js";
import { sendProbe } from "../lib/probe.js";
import { maskSecrets } from "../lib/mask.js";
import { inspectHeaders } from "../lib/headers.js";
import { summarizeCodexText } from "./text.js";

try {
  const model = process.argv[2] ?? "gpt-6-luna";
  if (!["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"].includes(model))
    throw new Error("Unsupported spike model");
  const auth = await loadCodexAuth();
  const secrets = [auth.accessToken, auth.accountId];
  const id = randomUUID();
  const result = await sendProbe({
    provider: "codex",
    name: `x2-${model.replaceAll(".", "-")}`,
    url: "https://chatgpt.com/backend-api/codex/responses",
    headers: new Headers({
      authorization: `Bearer ${auth.accessToken}`,
      "chatgpt-account-id": auth.accountId,
      "content-type": "application/json",
      accept: "text/event-stream",
      originator: "codex_cli_rs",
      "user-agent": "codex_cli_rs/0.159.2",
      "session-id": id,
      "thread-id": id,
      "x-client-request-id": id,
    }),
    body: {
      model,
      instructions: "You are a helpful assistant.",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Reply with the single word: pong" },
          ],
        },
      ],
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: "high" },
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    },
    secrets,
  });
  const { text, completed, failed } = summarizeCodexText(result.events);
  const success = result.ok && completed && !failed && text.trim() === "pong";
  console.log(
    JSON.stringify(
      maskSecrets(
        {
          model,
          status: result.status,
          requestNumber: result.requestNumber,
          success,
          text,
          completed,
          eventTypes: result.events.map((event) => event.event),
          usageHeaders: inspectHeaders(result.responseHeaders, secrets).usage,
          errorBody: result.body,
          paths: result.paths,
        },
        secrets,
      ),
      null,
      2,
    ),
  );
  if (!success) process.exitCode = 1;
} catch {
  console.error("Codex text probe failed; inspect masked local recordings");
  process.exitCode = 1;
}
