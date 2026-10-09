import { outputItems } from "./tool.js";
import { type SseEvent } from "../lib/sse.js";
import { sendProbe } from "../lib/probe.js";
import { codexHeaders, codexResponsesUrl } from "./request.js";
import { summarizeCodexText } from "./text.js";

export function encryptedReplayInput(saved: {
  requestBody: { input: unknown[] };
  events: SseEvent[];
}) {
  const items = outputItems(saved.events);
  if (
    !items.some(
      (item) =>
        item.type === "reasoning" &&
        typeof item.encrypted_content === "string" &&
        item.encrypted_content.length > 0,
    )
  )
    throw new Error("No encrypted reasoning to replay");
  if (!summarizeCodexText(saved.events).completed)
    throw new Error("Incomplete saved response");
  return [
    ...saved.requestBody.input,
    ...items,
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Reply again with the single word: pong" },
      ],
    },
  ];
}

export async function probeEncryptedReplay(
  auth: { accessToken: string; accountId: string },
  saved: { requestBody: { input: unknown[] }; events: SseEvent[] },
  options: { root?: string; fetcher?: typeof fetch } = {},
) {
  const input = encryptedReplayInput(saved);
  const result = await sendProbe({
    provider: "codex",
    name: "x3-encrypted-replay",
    url: codexResponsesUrl,
    headers: codexHeaders(auth),
    secrets: [auth.accessToken, auth.accountId],
    body: {
      model: "gpt-6-luna",
      instructions: "You are a helpful assistant.",
      input,
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: "max" },
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    },
    ...options,
  });
  const final = summarizeCodexText(result.events);
  return {
    status: result.status,
    requestNumber: result.requestNumber,
    paths: result.paths,
    success:
      result.ok &&
      final.completed &&
      !final.failed &&
      final.text.trim() === "pong",
    text: final.text,
    completed: final.completed,
  };
}
