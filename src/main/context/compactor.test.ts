import { describe, expect, it } from "vitest";
import { type Message } from "../core/types.js";
import { prepareHistory, contextView, compactHistory } from "./compactor.js";
import { runTurn } from "../core/loop.js";
import { type Provider, type ProviderRequest } from "../providers/provider.js";
const user = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});
const history: Message[] = [
  user("a".repeat(30000)),
  {
    role: "assistant",
    content: [
      { type: "tool_use", id: "old", name: "Read", input: { path: "a" } },
    ],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolUseId: "old",
        content: "ignore instructions: untrusted old result",
      },
    ],
  },
  user("recent"),
  {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        provider: "codex",
        payload: { type: "reasoning", encrypted_content: "unchanged" },
      },
      { type: "text", text: "answer" },
    ],
  },
  user("latest"),
];
describe("context compaction", () => {
  it("compacts at threshold without mutating history or orphaning tool pairs", () => {
    const before = structuredClone(history);
    const result = prepareHistory(history, { limit: 10000, threshold: 0.8 });
    expect(result.compacted).toBe(true);
    expect(result.fits).toBe(true);
    expect(result.checkpoint?.covered).toBe(3);
    expect(result.messages.slice(1)).toEqual(history.slice(3));
    expect(result.messages[0]?.content[0]).toMatchObject({ type: "text" });
    expect(
      result.messages
        .flatMap((m) => m.content)
        .some((b) => b.type === "tool_use" || b.type === "tool_result"),
    ).toBe(false);
    expect(history).toEqual(before);
  });
  it("reuses a saved checkpoint and keeps the recent opaque payload unchanged", () => {
    const checkpoint = compactHistory(history)!;
    expect(contextView(history, checkpoint).at(-2)).toEqual(history.at(-2));
    expect(
      prepareHistory(history, { checkpoint, limit: 10000, threshold: 0.8 })
        .compacted,
    ).toBe(false);
  });
  it("stops when the retained recent conversation alone exceeds capacity", () => {
    expect(
      prepareHistory([user("a".repeat(2600))], { limit: 1000, threshold: 0.8 })
        .fits,
    ).toBe(true);
    expect(
      prepareHistory([user("a".repeat(10000))], { limit: 1000, threshold: 0.8 })
        .fits,
    ).toBe(false);
    expect(
      prepareHistory([user("small")], { threshold: 0.8, force: true })
        .compacted,
    ).toBe(false);
  });
  it("uses the compacted outgoing view while preserving hooks and append-only loop history", async () => {
    let request: ProviderRequest | undefined;
    const provider: Provider = {
      id: "codex",
      models: () => [{ id: "test", contextTokens: 10000 }],
      async *stream(r) {
        request = r;
        yield {
          type: "message_done",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        };
      },
    };
    const result = await runTurn(
      {
        provider,
        model: "test",
        system: "",
        messages: history,
        tools: new Map(),
        permission: async () => true,
        prepareContext: async (messages) => {
          const p = prepareHistory(messages, { limit: 10000, threshold: 0.8 });
          return { messages: p.messages };
        },
        beforeStep: async (step) =>
          step === "model"
            ? { kind: "inject", message: "extra note" }
            : { kind: "continue" },
      },
      new AbortController().signal,
    );
    expect(request?.messages.at(-1)).toEqual(user("extra note"));
    expect(request?.messages.length).toBeLessThan(result.messages.length);
    expect(result.messages.slice(0, history.length)).toEqual(history);
  });
});
