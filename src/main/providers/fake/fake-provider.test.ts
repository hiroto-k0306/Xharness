import { describe, expect, it } from "vitest";
import { FakeProvider, routeFake, type FakeStep } from "./fake-provider.js";
import { runTurn } from "../../core/loop.js";
import { type ProviderEvent, type ProviderRequest } from "../provider.js";
import { type Tool } from "../../tools/registry.js";

const request = (text: string): ProviderRequest => ({
  model: "fake",
  system: "s",
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  tools: [],
});
async function gather(
  provider: FakeProvider,
  req: ProviderRequest,
  signal = new AbortController().signal,
) {
  const out: ProviderEvent[] = [];
  for await (const e of provider.stream(req, signal)) out.push(e);
  return out;
}
const readTool: Tool = {
  spec: { name: "Read", description: "Read", inputSchema: {} },
  readOnly: true,
  validate: async () => undefined,
  execute: async () => ({ content: "hello from a.txt" }),
};

describe("FakeProvider", () => {
  it("replays a text fixture through the real Claude decoder", async () => {
    const events = await gather(new FakeProvider(), request("hi"));
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    const done = events.find((e) => e.type === "message_done");
    expect(done).toMatchObject({ stopReason: "end_turn" });
  });
  it("replays a tool call, then a final answer in a full turn", async () => {
    const result = await runTurn(
      {
        provider: new FakeProvider(),
        model: "fake",
        system: "s",
        messages: request("please read a.txt").messages,
        tools: new Map([["Read", readTool]]),
        permission: async () => true,
      },
      new AbortController().signal,
    );
    expect(result.stopCause).toBe("end_turn");
    expect(
      result.messages.some((m) =>
        m.content.some((b) => b.type === "tool_result"),
      ),
    ).toBe(true);
  });
  it("reproduces a 429", async () => {
    const events = await gather(new FakeProvider(), request("trigger 429"));
    expect(events).toEqual([{ type: "rate_limited", retryAfterSec: 3 }]);
  });
  it.each(["claude", "codex"] as const)(
    "%s does not interpret UUID or hash substrings as a 429 control",
    (provider) => {
      const text =
        "XHarness fixed evaluation 00000429-0000-4000-8000-000000000001/ping\n" +
        "Version SHA-256: " +
        "a".repeat(30) +
        "429" +
        "b".repeat(31) +
        "\nTask:\nReply pong";
      expect(routeFake(request(text), provider).type).toBe("fixture");
      expect(routeFake(request("trigger 429"), provider).type).toBe(
        "rate_limited",
      );
    },
  );
  it("reproduces a stream cut as an error with no completion", async () => {
    const events = await gather(new FakeProvider(), request("cut"));
    expect(events.some((e) => e.type === "message_done")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });
  it("stops promptly when aborted mid-stream", async () => {
    const controller = new AbortController();
    const provider = new FakeProvider();
    const out: ProviderEvent[] = [];
    for await (const e of provider.stream(request("slow"), controller.signal)) {
      out.push(e);
      if (e.type === "text_delta") controller.abort();
    }
    expect(out.some((e) => e.type === "message_done")).toBe(false);
    expect(out.at(-1)).toMatchObject({
      type: "error",
      error: { kind: "aborted" },
    });
  });
  it("consumes an explicit script in order, then falls back to routing", async () => {
    const script: FakeStep[] = [
      { type: "rate_limited", retryAfterSec: 1 },
      { type: "error", kind: "transport" },
    ];
    const seen: string[] = [];
    const p = new FakeProvider({
      script,
      onRequest: (r) => seen.push(r.model),
    });
    expect((await gather(p, request("a")))[0]?.type).toBe("rate_limited");
    expect((await gather(p, request("a")))[0]).toMatchObject({
      type: "error",
      error: { kind: "transport", retryable: true },
    });
    expect((await gather(p, request("a"))).at(-1)?.type).toBe("message_done");
    expect(seen).toHaveLength(3);
  });
  it("loop recovers from a short fake 429 by retrying", async () => {
    const result = await runTurn(
      {
        provider: new FakeProvider({
          script: [{ type: "rate_limited", retryAfterSec: 1 }],
        }),
        model: "fake",
        system: "s",
        messages: request("hi").messages,
        tools: new Map(),
        permission: async () => true,
        sleep: async () => undefined,
      },
      new AbortController().signal,
    );
    expect(result.stopCause).toBe("end_turn");
  });
  it("rejects unsafe fixture names and routes by keyword", async () => {
    const events = await gather(
      new FakeProvider({
        script: [{ type: "fixture", name: "../../etc/passwd" }],
      }),
      request("x"),
    );
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(routeFake(request("read it"))).toMatchObject({
      name: "phase1-headless-read-1",
    });
  });
});
