import { type SseEvent } from "../lib/sse.js";
import { sendProbe } from "../lib/probe.js";
import { record } from "../lib/record.js";
import { maskSecrets } from "../lib/mask.js";
import { getTimeResult } from "../claude/tool.js";
import { codexHeaders, codexResponsesUrl } from "./request.js";
import { summarizeCodexText } from "./text.js";

export type OutputItem = {
  type: string;
  id?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  encrypted_content?: string;
  [key: string]: unknown;
};

export function outputItems(events: SseEvent[]): OutputItem[] {
  const result: OutputItem[] = [];
  for (const event of events) {
    if (event.data === "[DONE]") continue;
    const data = JSON.parse(event.data) as { type?: string; item?: OutputItem };
    if (data.type === "response.output_item.done") {
      if (!data.item || typeof data.item.type !== "string")
        throw new Error("Invalid output item");
      result.push(data.item);
    }
  }
  return result;
}

export async function probeCodexTool(
  auth: { accessToken: string; accountId: string },
  options: {
    root?: string;
    fetcher?: typeof fetch;
    effort?: "high" | "max";
  } = {},
) {
  const effort = options.effort ?? "high";
  const suffix = effort === "high" ? "" : "-max";
  const secrets = [auth.accessToken, auth.accountId];
  const headers = codexHeaders(auth);
  const input: unknown[] = [
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "What time is it in Tokyo? Use the tool.",
        },
      ],
    },
  ];
  const base = {
    model: "gpt-6-luna",
    instructions: "You are a helpful assistant.",
    reasoning: { effort },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    parallel_tool_calls: false,
    tools: [
      {
        type: "function",
        name: "get_time",
        description: "Get the current time in a timezone",
        parameters: {
          type: "object",
          properties: { timezone: { type: "string" } },
          required: ["timezone"],
          additionalProperties: false,
        },
        strict: true,
      },
    ],
  };
  const send = (name: string) =>
    sendProbe({
      provider: "codex",
      name,
      url: codexResponsesUrl,
      headers,
      body: { ...base, tool_choice: "auto", input },
      secrets,
      ...options,
    });
  const first = await send(`x3-tool-1${suffix}`);
  const firstSummary = summarizeCodexText(first.events);
  if (!first.ok || !firstSummary.completed || firstSummary.failed)
    return {
      success: false,
      report: maskSecrets(
        { stage: 1, status: first.status, body: first.body, ...firstSummary },
        secrets,
      ),
    };
  const items = outputItems(first.events);
  const calls = items.filter((item) => item.type === "function_call");
  const call = calls[0];
  if (
    calls.length !== 1 ||
    call?.name !== "get_time" ||
    typeof call.call_id !== "string" ||
    typeof call.arguments !== "string"
  )
    throw new Error("Expected one get_time function call");
  let timezone: unknown;
  try {
    timezone = (JSON.parse(call.arguments) as { timezone?: unknown }).timezone;
  } catch {
    throw new Error("Invalid function arguments");
  }
  if (typeof timezone !== "string") throw new Error("Invalid timezone");
  const time = getTimeResult(timezone);
  // Replay the native output items, including any encrypted reasoning, unchanged.
  input.push(...items, {
    type: "function_call_output",
    call_id: call.call_id,
    output: JSON.stringify(time),
  });
  const second = await send(`x3-tool-2${suffix}`);
  const final = summarizeCodexText(second.events);
  const paths = await record(
    "codex",
    `tool-roundtrip${suffix}`,
    {
      requestHeaders: headers,
      responseHeaders: second.responseHeaders,
      status: second.status,
      events: [first.events, second.events],
      body: { firstStatus: first.status, secondBody: second.body },
    },
    { root: options.root, secrets },
  );
  const success =
    second.ok && final.completed && !final.failed && !!final.text.trim();
  return {
    success,
    report: maskSecrets(
      {
        success,
        statuses: [first.status, second.status],
        time,
        final,
        paths,
        replayedItemTypes: items.map((item) => item.type),
        encryptedReasoningReturned: items.some(
          (item) =>
            item.type === "reasoning" &&
            typeof item.encrypted_content === "string",
        ),
      },
      secrets,
    ),
  };
}
