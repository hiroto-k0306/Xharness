import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { runTurn } from "../../core/loop.js";
import { type Tool } from "../../tools/registry.js";
import { type ProviderEvent, type ProviderRequest } from "../provider.js";
import { CodexAdapter } from "./adapter.js";
import { decodeCodexStream } from "./stream.js";

const recorded = JSON.parse(
  await readFile("test/fixtures/codex/stream-error.json", "utf8"),
) as {
  payload: {
    type: string;
    error: { type: string; code: string; message: string };
  };
};
interface Recording {
  events: { event: string; data: string }[];
}
async function recording(name: string): Promise<Recording> {
  return JSON.parse(
    await readFile(`test/fixtures/codex/${name}.json`, "utf8"),
  ) as Recording;
}
function sse(data: unknown[]) {
  return new Response(
    data.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""),
  );
}
function replay(f: Recording) {
  return new Response(
    f.events.map((e) => `event: ${e.event}\ndata: ${e.data}\n\n`).join(""),
  );
}
const request: ProviderRequest = {
  model: "gpt-6-luna",
  system: "Be concise.",
  messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
  tools: [],
};
function adapter(fetcher: typeof fetch) {
  return new CodexAdapter({
    getCredentials: async () => ({
      accessToken: "synthetic-token",
      accountId: "synthetic-account",
    }),
    fetcher,
  });
}
async function collect(payload: unknown): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of adapter(async () => sse([payload])).stream(
    request,
    new AbortController().signal,
  ))
    events.push(event);
  return events;
}

describe("Codex stream failure recovery", () => {
  it.each(["error", "response.failed"])(
    "classifies the recorded overload in %s without exposing raw data",
    async (type) => {
      // response.failed is a synthetic envelope around the observed error fields.
      const error = {
        ...recorded.payload.error,
        message: "synthetic-token synthetic-account",
        headers: { Authorization: "synthetic-token" },
      };
      const payload =
        type === "error" ? { type, error } : { type, response: { error } };
      const events = await collect(payload);
      expect(events.at(-1)).toEqual({
        type: "error",
        error: {
          kind: "transport",
          message: "Codex側が一時的に混雑しています",
          retryable: true,
        },
      });
      expect(events.some((e) => e.type === "message_done")).toBe(false);
      expect(JSON.stringify(events)).not.toMatch(
        /synthetic-token|synthetic-account|Authorization/,
      );
    },
  );

  it.each([
    undefined,
    null,
    [],
    "bad",
    { type: "authentication_error", code: "invalid_api_key" },
    { type: "invalid_request_error", code: "server_is_overloaded" },
    { type: "service_unavailable_error", code: "unobserved_code" },
  ])("does not retry an unknown or non-overload failure: %j", async (error) => {
    const events = await collect({ type: "error", error });
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { kind: "protocol", retryable: false },
    });
    expect(JSON.stringify(events)).not.toContain("拒否");
  });

  it.each([undefined, null, [], "bad", 42, {}, { error: null }])(
    "returns a non-retryable event for malformed response.failed: %j",
    async (response) => {
      // Decode directly so the Adapter cannot hide an unexpected exception.
      const events: ProviderEvent[] = [];
      for await (const event of decodeCodexStream(
        sse([{ type: "response.failed", response }]),
      ))
        events.push(event);
      expect(events.at(-1)).toMatchObject({
        type: "error",
        error: { kind: "protocol", retryable: false },
      });
      expect(events.some((e) => e.type === "message_done")).toBe(false);
    },
  );

  it("recovers with identical history and never executes tools from the failed attempt", async () => {
    const toolResponse = await recording("x3-tool-1");
    const toolItem = toolResponse.events
      .filter((e) => e.event === "response.output_item.done")
      .map(
        (e) =>
          JSON.parse(e.data) as {
            type?: string;
            item?: { type: string; name: string };
          },
      )
      .find(
        (e) =>
          e.type === "response.output_item.done" &&
          e.item?.type === "function_call",
      )!;
    const execute = vi.fn(async () => ({ content: "synthetic tool result" }));
    const tool: Tool = {
      spec: {
        name: toolItem.item!.name,
        description: "fixture tool",
        inputSchema: { type: "object" },
      },
      readOnly: false,
      validate: async () => undefined,
      execute,
    };
    const success = await recording("x2-gpt-6-luna");
    const requests: unknown[] = [];
    let attempts = 0;
    const provider = adapter(async (_url, init) => {
      requests.push(JSON.parse(init!.body as string));
      switch (attempts++) {
        case 0:
          return sse([toolItem, recorded.payload]);
        case 1:
          return replay(toolResponse);
        default:
          return replay(success);
      }
    });
    const permission = vi.fn(async () => true);
    const delays: number[] = [];
    const result = await runTurn(
      {
        provider,
        model: request.model,
        system: request.system,
        messages: request.messages,
        tools: new Map([[tool.spec.name, tool]]),
        permission,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
      new AbortController().signal,
    );
    expect(result.stopCause).toBe("end_turn");
    expect(attempts).toBe(3);
    expect(delays).toEqual([1000]);
    expect(requests[0]).toEqual(requests[1]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(permission).toHaveBeenCalledTimes(1);
    expect(result.messages.filter((m) => m.role === "assistant")).toHaveLength(
      2,
    );
  });

  it("stops after the existing three retries instead of looping indefinitely", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => sse([recorded.payload]));
    const delays: number[] = [];
    const result = await runTurn(
      {
        provider: adapter(fetcher),
        model: request.model,
        system: request.system,
        messages: request.messages,
        tools: new Map(),
        permission: async () => true,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
      new AbortController().signal,
    );
    expect(result.stopCause).toBe("transport");
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(result.messages).toEqual(request.messages);
  });

  it("honors user cancellation during the retry wait", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => sse([recorded.payload]));
    const result = await runTurn(
      {
        provider: adapter(fetcher),
        model: request.model,
        system: request.system,
        messages: request.messages,
        tools: new Map(),
        permission: async () => true,
        sleep: async () => {
          controller.abort();
        },
      },
      controller.signal,
    );
    expect(result.stopCause).toBe("aborted");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 400])("does not retry HTTP %i", async (status) => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("synthetic-token", { status }),
    );
    const sleep = vi.fn(async () => undefined);
    const result = await runTurn(
      {
        provider: adapter(fetcher),
        model: request.model,
        system: request.system,
        messages: request.messages,
        tools: new Map(),
        permission: async () => true,
        sleep,
      },
      new AbortController().signal,
    );
    expect(result.stopCause).toBe(
      status === 400 ? "request" : "authentication",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
