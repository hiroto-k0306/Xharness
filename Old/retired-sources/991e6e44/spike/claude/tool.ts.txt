import { sendProbe } from "../lib/probe.js";
import { record } from "../lib/record.js";
import { maskSecrets } from "../lib/mask.js";
import { summarizeText } from "./text.js";
import { type SseEvent } from "../lib/sse.js";

type Block =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
    };

export function getTimeResult(requestedTimezone: string, now = new Date()) {
  const timezone =
    requestedTimezone === "Tokyo" ? "Asia/Tokyo" : requestedTimezone;
  const localTime = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(now);
  return { timezone, utc: now.toISOString(), localTime };
}

export function assembleToolMessage(events: SseEvent[]): Block[] {
  const blocks = new Map<
    number,
    { block: Block; fragments: string[]; stopped: boolean }
  >();
  for (const event of events) {
    const data = JSON.parse(event.data) as {
      index?: number;
      content_block?: Block;
      delta?: { type?: string; text?: string; partial_json?: string };
    };
    if (event.event === "content_block_start") {
      if (
        !Number.isInteger(data.index) ||
        !data.content_block ||
        !["text", "tool_use"].includes(data.content_block.type)
      )
        throw new Error("Unsupported Claude content block");
      blocks.set(data.index!, {
        block: { ...data.content_block },
        fragments: [],
        stopped: false,
      });
    } else if (
      event.event === "content_block_delta" ||
      event.event === "content_block_stop"
    ) {
      const current = blocks.get(data.index!);
      if (!current || current.stopped)
        throw new Error("Invalid Claude block order");
      if (event.event === "content_block_stop") current.stopped = true;
      else if (
        data.delta?.type === "text_delta" &&
        current.block.type === "text"
      ) {
        if (typeof data.delta.text !== "string")
          throw new Error("Invalid text delta");
        current.block.text += data.delta.text;
      } else if (
        data.delta?.type === "input_json_delta" &&
        current.block.type === "tool_use"
      ) {
        if (typeof data.delta.partial_json !== "string")
          throw new Error("Invalid tool delta");
        current.fragments.push(data.delta.partial_json);
      } else throw new Error("Unsupported Claude delta");
    }
  }
  return [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, current]) => {
      if (!current.stopped) throw new Error("Incomplete Claude content block");
      if (current.block.type === "tool_use" && current.fragments.length) {
        try {
          current.block.input = JSON.parse(current.fragments.join(""));
        } catch {
          throw new Error("Invalid tool input JSON");
        }
      }
      return current.block;
    });
}

export async function probeTool(
  accessToken: string,
  options: {
    root?: string;
    fetcher?: typeof fetch;
    first?: {
      ok: boolean;
      status: number;
      events: SseEvent[];
      body?: unknown;
    };
  } = {},
) {
  const headers = new Headers({
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
  });
  const messages: unknown[] = [
    { role: "user", content: "What time is it in Tokyo? Use the tool." },
  ];
  const base = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    stream: true,
    tools: [
      {
        name: "get_time",
        description: "Get the current time in a timezone",
        input_schema: {
          type: "object",
          properties: { timezone: { type: "string" } },
          required: ["timezone"],
        },
      },
    ],
  };
  const send = (name: string) =>
    sendProbe({
      provider: "claude",
      name,
      url: "https://api.anthropic.com/v1/messages",
      headers,
      body: { ...base, messages },
      secrets: [accessToken],
      ...options,
    });
  const first = options.first ?? (await send("c3-tool-1"));
  const summary = summarizeText(first.events);
  if (!first.ok || !summary.complete || summary.stopReason !== "tool_use")
    return {
      success: false,
      report: maskSecrets(
        { stage: 1, status: first.status, body: first.body, ...summary },
        [accessToken],
      ),
    };
  const content = assembleToolMessage(first.events);
  const tools = content.filter((block) => block.type === "tool_use");
  if (tools.length !== 1 || tools[0]?.name !== "get_time")
    throw new Error("Expected one get_time call");
  const call = tools[0];
  const input = call.input as { timezone?: unknown };
  if (typeof input?.timezone !== "string")
    throw new Error("Invalid timezone input");
  const time = getTimeResult(input.timezone);
  messages.push(
    { role: "assistant", content },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(time),
        },
      ],
    },
  );
  const second = await send("c3-tool-2");
  const final = summarizeText(second.events);
  const paths = await record(
    "claude",
    "tool-roundtrip",
    {
      requestHeaders: headers,
      responseHeaders: second.responseHeaders,
      status: second.status,
      events: [first.events, second.events],
      body: { firstStatus: first.status, secondBody: second.body },
    },
    { root: options.root, secrets: [accessToken] },
  );
  const success =
    second.ok &&
    final.complete &&
    final.stopReason === "end_turn" &&
    !!final.text.trim();
  return {
    success,
    report: maskSecrets(
      {
        success,
        statuses: [first.status, second.status],
        timezone: time.timezone,
        requestedTimezone: input.timezone,
        resumedFirst: !!options.first,
        time,
        inputDeltaCount: first.events.filter(
          (event) =>
            event.event === "content_block_delta" &&
            event.data.includes("input_json_delta"),
        ).length,
        final,
        paths,
      },
      [accessToken],
    ),
  };
}
