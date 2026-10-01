import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { loadModelCatalog } from "../../config/model-catalog.js";
import { type ProviderEvent, type ProviderRequest } from "../provider.js";
import { CodexAdapter } from "./adapter.js";
import { toCodexInput, toCodexRequest } from "./convert.js";
import { codexRetryAfter, codexUsage } from "./usage.js";

interface Fixture {
  events: { event: string; data: string }[];
  responseHeaders: { all: Record<string, string> };
  requestBody: { input: Record<string, unknown>[] };
}
async function fixture(name: string): Promise<Fixture> {
  return JSON.parse(
    await readFile(`test/fixtures/codex/${name}.json`, "utf8"),
  ) as Fixture;
}
it("maps hosted search modes from CLI semantics and rejects invalid quota resets", () => {
  for (const mode of ["live", "cached"] as const) {
    const body = toCodexRequest(
      { ...request, webSearch: { mode } },
      loadModelCatalog(),
    );
    expect(body.tools).toEqual([
      { type: "web_search", external_web_access: mode === "live" },
    ]);
  }
  expect(
    codexUsage(
      new Headers({
        "x-codex-primary-reset-at": "1e100",
        "x-codex-primary-used-percent": "12",
      }),
    ).windows[0],
  ).toMatchObject({ usedPercent: 12 });
  expect(
    codexUsage(new Headers({ "x-codex-primary-reset-at": "1e100" })).windows,
  ).toEqual([]);
});
function response(recorded: Fixture, events = recorded.events) {
  const bytes = new TextEncoder().encode(
    events.map((e) => `event: ${e.event}\r\ndata: ${e.data}\r\n\r\n`).join(""),
  );
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (offset >= bytes.length) return c.close();
        c.enqueue(bytes.slice(offset, (offset += 7)));
      },
    }),
    { headers: recorded.responseHeaders.all },
  );
}
const request: ProviderRequest = {
  model: "gpt-6-luna",
  system: "Be concise.",
  messages: [
    { role: "user", content: [{ type: "text", text: "Reply pong." }] },
  ],
  tools: [],
};
async function gather(source: AsyncIterable<ProviderEvent>) {
  const events: ProviderEvent[] = [];
  for await (const e of source) events.push(e);
  return events;
}
function completion(events: ProviderEvent[]) {
  const done = events.find((e) => e.type === "message_done");
  if (!done || done.type !== "message_done")
    throw new Error("Missing completion");
  return done;
}
const credentials = async () => ({
  accessToken: "test-secret",
  accountId: "test-account",
});
async function collect(res: Response, req = request) {
  return gather(
    new CodexAdapter({
      getCredentials: credentials,
      fetcher: async () => res,
    }).stream(req, new AbortController().signal),
  );
}

describe("Codex conversion using Phase 0 recordings", () => {
  it.each(["luna", "astra", "1-sol"])(
    "replays the real %s text and quota headers without Content-Type",
    async (model) => {
      const f = await fixture(`x2-gpt-6-${model}`);
      const events = await collect(response(f));
      expect(completion(events).message.content).toEqual([
        { type: "text", text: "pong" },
      ]);
      expect(completion(events).usage).toMatchObject({
        inputTokens: 23,
        outputTokens: 5,
      });
      expect(events.find((e) => e.type === "usage")).toMatchObject({
        provider: "codex",
        windows: expect.arrayContaining([
          expect.objectContaining({ windowMinutes: 300 }),
        ]),
      });
    },
  );
  it("returns function_call with the same call_id and function_call_output", async () => {
    const first = completion(
      await collect(response(await fixture("x3-tool-1"))),
    );
    const call = first.message.content.find((b) => b.type === "tool_use");
    if (!call || call.type !== "tool_use") throw new Error("Missing call");
    const input = toCodexInput([
      first.message,
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: call.id,
            content: '{"now":"2026-10-01T03:34:04Z"}',
          },
        ],
      },
    ]);
    expect(input[0]).toMatchObject({
      type: "function_call",
      call_id: call.id,
      name: "get_time",
      arguments: JSON.stringify(call.input),
    });
    expect(input[1]).toMatchObject({
      type: "function_call_output",
      call_id: call.id,
    });
    const second = completion(
      await collect(response(await fixture("x3-tool-2"))),
    );
    expect(second.stopReason).toBe("end_turn");
    expect(
      second.message.content.some(
        (b) => b.type === "text" && b.text.includes("Tokyo"),
      ),
    ).toBe(true);
  });
  it("returns encrypted reasoning unmodified between models of the same provider", async () => {
    const f = await fixture("x4-gpt-6-luna-max");
    const before = JSON.stringify(f);
    const first = completion(await collect(response(f)));
    const native = f.events
      .filter((e) => e.event === "response.output_item.done")
      .map((e) => JSON.parse(e.data) as { item?: Record<string, unknown> })
      .find((e) => e.item?.type === "reasoning")?.item;
    expect(native?.encrypted_content).toEqual(expect.any(String));
    for (const model of ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]) {
      const input = toCodexRequest(
        { ...request, model, messages: [...request.messages, first.message] },
        loadModelCatalog(),
      ).input;
      expect(input.find((i) => i.type === "reasoning")).toEqual(native);
    }
    expect(JSON.stringify(f)).toBe(before);
    expect(
      completion(await collect(response(await fixture("x3-encrypted-replay"))))
        .stopReason,
    ).toBe("end_turn");
  });
  it("maps foreign tool IDs consistently and drops foreign reasoning only in the outgoing input", () => {
    const messages: ProviderRequest["messages"] = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            provider: "claude",
            payload: { type: "thinking", thinking: "private" },
          },
          {
            type: "tool_use",
            id: "toolu_foreign",
            name: "Read",
            input: { path: "a" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_foreign",
            content: [{ type: "text", text: "ok" }],
          },
        ],
      },
    ];
    const before = structuredClone(messages);
    const input = toCodexInput(messages);
    expect(input).toHaveLength(2);
    expect(input[0]!.call_id).toMatch(/^call_/);
    expect(input[1]!.call_id).toBe(input[0]!.call_id);
    expect(messages).toEqual(before);
  });
  it("sends only catalog efforts and the recorded headers/body", async () => {
    const f = await fixture("x2-gpt-6-luna");
    let body: Record<string, unknown> = {};
    let headers = new Headers();
    const adapter = new CodexAdapter({
      getCredentials: credentials,
      fetcher: async (_url, init) => {
        body = JSON.parse(init!.body as string) as Record<string, unknown>;
        headers = new Headers(init!.headers);
        return response(f);
      },
    });
    await gather(
      adapter.stream(
        { ...request, sessionId: "test-session", reasoning: { effort: "low" } },
        new AbortController().signal,
      ),
    );
    expect(body).toMatchObject({
      store: false,
      stream: true,
      tool_choice: "auto",
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "low" },
    });
    for (const name of [
      "authorization",
      "chatgpt-account-id",
      "originator",
      "user-agent",
      "session-id",
      "thread-id",
      "x-client-request-id",
      "accept",
    ])
      expect(headers.has(name)).toBe(true);
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("thread-id")).toBe("test-session");
    expect(headers.has("openai-beta")).toBe(false);
    expect(() =>
      toCodexRequest(
        { ...request, reasoning: { effort: "ultra" as "high" } },
        loadModelCatalog(),
      ),
    ).toThrow();
    expect(() =>
      toCodexRequest({ ...request, model: "gpt-reserve" }, loadModelCatalog()),
    ).toThrow();
  });
  it("emits no completion for truncated or aborted SSE and hides exception secrets", async () => {
    const f = await fixture("x3-tool-1");
    const cut = await collect(response(f, f.events.slice(0, -1)));
    expect(cut.some((e) => e.type === "message_done")).toBe(false);
    expect(cut.at(-1)).toMatchObject({
      type: "error",
      error: { kind: "protocol" },
    });
    const abort = new AbortController();
    abort.abort();
    const fetcher = vi.fn<typeof fetch>();
    const events = await gather(
      new CodexAdapter({ fetcher, getCredentials: credentials }).stream(
        request,
        abort.signal,
      ),
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { kind: "aborted" },
    });
    const errors = await gather(
      new CodexAdapter({
        getCredentials: async () => {
          throw new Error("test-secret test-account");
        },
      }).stream(request, new AbortController().signal),
    );
    expect(JSON.stringify(errors)).not.toMatch(/test-secret|test-account/);
  });
  it.each([401, 403, 429, 500])(
    "handles HTTP %i without exposing its body",
    async (status) => {
      const events = await collect(
        new Response("test-secret", {
          status,
          headers: { "retry-after": "3" },
        }),
      );
      expect(events.at(-1)).toMatchObject(
        status === 429
          ? { type: "rate_limited", retryAfterSec: 3 }
          : {
              type: "error",
              error: {
                kind: status === 500 ? "request" : "authentication",
                retryable: status === 500,
              },
            },
      );
      expect(JSON.stringify(events)).not.toContain("test-secret");
    },
  );
  it("keeps missing quota fields unavailable and derives reset-based retry delays", () => {
    expect(codexUsage(new Headers()).windows).toEqual([]);
    const headers = new Headers({
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1790840426",
    });
    expect(codexRetryAfter(headers, 1790840400000)).toBe(26);
    expect(codexUsage(headers).windows[0]!.resetAt).toBe(
      "2026-10-01T07:40:26.000Z",
    );
    expect(codexRetryAfter(new Headers(), Date.now())).toBeUndefined();
  });
});
