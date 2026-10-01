import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { type ProviderEvent, type ProviderRequest } from "../provider.js";
import { ClaudeAdapter } from "./adapter.js";
import { claudeIdentity, toClaudeRequest } from "./convert.js";
import { claudeRateLimit } from "./rate-limit.js";

async function gather<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}
async function fixture(name: string) {
  return JSON.parse(
    await readFile(`test/fixtures/claude/${name}.json`, "utf8"),
  ) as {
    events: { event: string; data: string }[];
    requestBody: { messages: unknown[] };
    responseHeaders: { all: Record<string, string> };
  };
}
const request: ProviderRequest = {
  model: "claude-haiku-4-5",
  system: "Be concise.",
  messages: [
    { role: "user", content: [{ type: "text", text: "Reply pong." }] },
  ],
  tools: [],
  maxOutputTokens: 64,
};
function response(events: { event: string; data: string }[]) {
  const bytes = new TextEncoder().encode(
    events.map((e) => `event: ${e.event}\r\ndata: ${e.data}\r\n\r\n`).join(""),
  );
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, (offset += 7)));
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}
async function collect(res: Response, req = request) {
  const adapter = new ClaudeAdapter({
    getAccessToken: async () => "test-secret",
    fetcher: async () => res,
  });
  return gather(adapter.stream(req, new AbortController().signal));
}
function done(events: ProviderEvent[]) {
  const result = events.find((e) => e.type === "message_done");
  if (!result || result.type !== "message_done")
    throw new Error("Expected completion");
  return result;
}

describe("Claude conversion using Phase 0 recordings", () => {
  it.each(["opus", "sonnet"])(
    "replays the real %s high-effort probe",
    async (model) => {
      const recorded = await fixture(`phase1-${model}-effort-high`);
      const events = await collect(response(recorded.events));
      expect(done(events).stopReason).toBe("end_turn");
      expect(done(events).message.content).toEqual([
        { type: "text", text: "pong" },
      ]);
    },
  );
  it.each(["haiku", "opus", "sonnet"])(
    "replays the completed Phase 1 %s adapter probe",
    async (model) => {
      const recorded = await fixture(`phase1-${model}-text`);
      const events = await collect(response(recorded.events));
      expect(done(events).stopReason).toBe("end_turn");
      expect(done(events).message.content).toEqual([
        { type: "text", text: "pong" },
      ]);
    },
  );
  it("replays the real REPL Read round trip", async () => {
    const first = done(
      await collect(response((await fixture("phase1-headless-read-1")).events)),
    );
    expect(first.stopReason).toBe("tool_use");
    expect(first.message.content).toContainEqual(
      expect.objectContaining({
        type: "tool_use",
        name: "Read",
        input: { path: "a.txt" },
      }),
    );
    const second = done(
      await collect(response((await fixture("phase1-headless-read-2")).events)),
    );
    expect(second.stopReason).toBe("end_turn");
    expect(second.message.content).toEqual([{ type: "text", text: "pong" }]);
  });
  it("always puts identity before the custom system", () => {
    expect(toClaudeRequest(request).system).toEqual([
      { type: "text", text: claudeIdentity },
      {
        type: "text",
        text: "Be concise.",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(toClaudeRequest({ ...request, system: "" }).system).toEqual([
      {
        type: "text",
        text: claudeIdentity,
        cache_control: { type: "ephemeral" },
      },
    ]);
  });
  it("marks system, tools and the latest message without mutating history", () => {
    const req = {
      ...request,
      tools: [
        { name: "Read", description: "Read", inputSchema: { type: "object" } },
      ],
    };
    const before = structuredClone(req);
    const converted = toClaudeRequest(req);
    expect(converted.system[0]).not.toHaveProperty("cache_control");
    expect(converted.system.at(-1)).toHaveProperty("cache_control", {
      type: "ephemeral",
    });
    expect(converted.tools?.at(-1)).toHaveProperty("cache_control", {
      type: "ephemeral",
    });
    expect(converted.messages.at(-1)?.content.at(-1)).toHaveProperty(
      "cache_control",
      { type: "ephemeral" },
    );
    expect(req).toEqual(before);
  });
  it("converts images and nested error tool results", () => {
    const converted = toClaudeRequest({
      ...request,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "tool_1",
              isError: true,
              content: [
                { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
              ],
            },
          ],
        },
      ],
    });
    expect(converted.messages[0]!.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tool_1",
      is_error: true,
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
        },
      ],
    });
  });
  it("accepts the real OAuth cache-marker probe", async () => {
    const events = await collect(
      response((await fixture("phase1-cache-haiku-text")).events),
    );
    expect(done(events).message.content).toEqual([
      { type: "text", text: "pong" },
    ]);
    expect(done(events).usage).toMatchObject({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
  it("assembles thinking and signature deltas as opaque same-provider blocks", async () => {
    const recorded = await fixture("phase1-haiku-text");
    const thought = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "thought" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "opaque" },
      },
      { type: "content_block_stop", index: 0 },
    ].map((data) => ({ event: data.type, data: JSON.stringify(data) }));
    const textEvents = recorded.events.slice(1).map((event) => {
      const data = JSON.parse(event.data) as Record<string, unknown>;
      if (typeof data.index === "number") data.index++;
      return { event: event.event, data: JSON.stringify(data) };
    });
    const converted = await collect(
      response([recorded.events[0]!, ...thought, ...textEvents]),
    );
    expect(done(converted).message.content[0]).toEqual({
      type: "reasoning",
      provider: "claude",
      payload: { type: "thinking", thinking: "thought", signature: "opaque" },
    });
    expect(converted).toContainEqual({
      type: "reasoning_delta",
      text: "thought",
    });
  });
  it("assembles actual tool JSON once and preserves IDs in the round trip", async () => {
    const recorded = await fixture("c3-tool-1");
    const events = await collect(response(recorded.events));
    const tool = events.filter((e) => e.type === "tool_use");
    expect(tool).toEqual([
      {
        type: "tool_use",
        id: "toolu_011R6vow3RQV49NFdwEhpmjF",
        name: "get_time",
        input: { timezone: "Tokyo" },
      },
    ]);
    const completion = done(events);
    expect(completion.stopReason).toBe("tool_use");
    expect(completion.usage).toMatchObject({
      inputTokens: 569,
      outputTokens: 54,
    });
    const converted = toClaudeRequest({
      ...request,
      messages: [
        completion.message,
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: tool[0]!.id,
              content: "2026-10-01T03:27:16.000Z",
            },
          ],
        },
      ],
    });
    expect(converted.messages[0]!.content[0]).toMatchObject({
      type: "tool_use",
      id: tool[0]!.id,
      input: { timezone: "Tokyo" },
    });
    expect(converted.messages[1]!.content[0]).toMatchObject({
      tool_use_id: tool[0]!.id,
      content: "2026-10-01T03:27:16.000Z",
    });
  });
  it("reads CRLF regardless of Content-Type and returns cumulative usage", async () => {
    const recorded = await fixture("c2-opus-identity");
    const events = await collect(response(recorded.events));
    expect(
      events
        .filter((e) => e.type === "text_delta")
        .map((e) => e.text)
        .join(""),
    ).toBe("pong");
    expect(done(events).message.content).toEqual([
      { type: "text", text: "pong" },
    ]);
    expect(done(events).stopReason).toBe("end_turn");
  });
  it("does not complete a truncated actual stream", async () => {
    const recorded = await fixture("c3-tool-1");
    const events = await collect(response(recorded.events.slice(0, -1)));
    expect(events.some((e) => e.type === "message_done")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { kind: "protocol" },
    });
  });
  it("does not execute malformed partial tool JSON", async () => {
    const recorded = await fixture("c3-tool-1");
    const events = recorded.events.map((e) =>
      e.data.includes("partial_json")
        ? {
            ...e,
            data: JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: "{" },
            }),
          }
        : e,
    );
    const converted = await collect(response(events));
    expect(converted.some((e) => e.type === "tool_use")).toBe(false);
    expect(converted.at(-1)).toMatchObject({
      type: "error",
      error: { kind: "protocol" },
    });
  });
  it("preserves same-provider reasoning and omits foreign opaque payloads", () => {
    const native = {
      type: "thinking",
      thinking: "sample",
      signature: "opaque",
    };
    const converted = toClaudeRequest({
      ...request,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              provider: "codex",
              payload: { encrypted_content: "foreign" },
            },
            { type: "reasoning", provider: "claude", payload: native },
            { type: "text", text: "answer" },
          ],
        },
      ],
    });
    expect(converted.messages[0]!.content).toEqual([
      native,
      { type: "text", text: "answer", cache_control: { type: "ephemeral" } },
    ]);
  });
  it("omits effort for Haiku even if a common request supplied it", () => {
    expect(
      toClaudeRequest({ ...request, reasoning: { effort: "high" } }),
    ).not.toHaveProperty("output_config");
  });
  it.each(["claude-opus-5-5", "claude-sonnet-5-5"])(
    "defaults %s to high without disabling thinking",
    (model) => {
      const converted = toClaudeRequest({
        ...request,
        model,
        tools: [
          {
            name: "Read",
            description: "Read",
            inputSchema: { type: "object" },
          },
        ],
      });
      expect(converted.output_config).toEqual({ effort: "high" });
      expect(converted).not.toHaveProperty("thinking");
      expect(converted.tool_choice).toEqual({ type: "auto" });
      for (const effort of ["low", "medium", "high", "xhigh", "max"] as const)
        expect(
          toClaudeRequest({ ...request, model, reasoning: { effort } })
            .output_config,
        ).toEqual({ effort });
    },
  );
  it("returns an unchanged thinking/signature block across appended tool results", () => {
    const thinking = Object.freeze({
      type: "thinking",
      thinking: "original thought",
      signature: "original signature",
      extension: { opaque: "unchanged" },
    });
    const history: ProviderRequest["messages"] = [
      { role: "user", content: [{ type: "text", text: "start" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", provider: "claude", payload: thinking },
          {
            type: "tool_use",
            id: "tool_1",
            name: "Read",
            input: { path: "a.txt" },
          },
        ],
      },
    ];
    const before = structuredClone(history);
    const first = toClaudeRequest({
      ...request,
      model: "claude-opus-5-5",
      messages: history,
    });
    history.push({
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "tool_1", content: "read result" },
      ],
    });
    const second = toClaudeRequest({
      ...request,
      model: "claude-opus-5-5",
      messages: history,
    });
    expect(history.slice(0, before.length)).toEqual(before);
    expect(first.messages[1]!.content[0]).toEqual(thinking);
    expect(second.messages[1]!.content[0]).toEqual(thinking);
    expect(second.messages[1]!.content[0]).not.toHaveProperty("cache_control");
  });
});

describe("rate limits and safe failures", () => {
  it("computes the claimed reset using observed Phase 0 headers", async () => {
    const recorded = await fixture("c3-tool-1");
    const headers = new Headers(recorded.responseHeaders.all);
    expect(claudeRateLimit(headers, 1791115199001)).toEqual({
      scope: "7d",
      retryAfterSec: 1,
    });
    expect(claudeRateLimit(headers, 1791115201000).retryAfterSec).toBe(0);
    expect(
      await collect(new Response("ignored", { status: 429, headers })),
    ).toEqual([
      { type: "rate_limited", scope: "7d", retryAfterSec: expect.any(Number) },
    ]);
  });
  it("reports an unknown wait when the actual Opus 429 has no reset", async () => {
    const recorded = await fixture("c2-opus-none-recheck");
    const events = await collect(
      new Response("test-secret", {
        status: 429,
        headers: recorded.responseHeaders.all,
      }),
    );
    expect(events).toEqual([
      { type: "rate_limited", retryAfterSec: undefined, scope: undefined },
    ]);
  });
  it("never exposes raw HTTP or transport exceptions", async () => {
    expect(
      JSON.stringify(
        await collect(new Response("test-secret", { status: 401 })),
      ),
    ).not.toContain("test-secret");
    const adapter = new ClaudeAdapter({
      getAccessToken: async () => "test-secret",
      fetcher: async () => {
        throw new Error("test-secret");
      },
    });
    const events = await gather(
      adapter.stream(request, new AbortController().signal),
    );
    expect(events).toMatchObject([
      { type: "error", error: { kind: "transport" } },
    ]);
    expect(JSON.stringify(events)).not.toContain("test-secret");
  });
  it("does not send a request after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const adapter = new ClaudeAdapter({
      getAccessToken: async () => {
        called = true;
        return "unused";
      },
    });
    expect(
      await gather(adapter.stream(request, controller.signal)),
    ).toMatchObject([{ type: "error", error: { kind: "aborted" } }]);
    expect(called).toBe(false);
  });
  it("does not complete buffered events after cancellation", async () => {
    const recorded = await fixture("c2-opus-identity");
    const controller = new AbortController();
    const adapter = new ClaudeAdapter({
      getAccessToken: async () => "test-secret",
      fetcher: async () => response(recorded.events),
    });
    const events: ProviderEvent[] = [];
    for await (const event of adapter.stream(request, controller.signal)) {
      events.push(event);
      if (event.type === "text_delta") controller.abort();
    }
    expect(events.some((e) => e.type === "message_done")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { kind: "aborted" },
    });
  });
});
