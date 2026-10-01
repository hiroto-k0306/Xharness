import { describe, expect, it } from "vitest";
import { runTurn } from "./loop.js";
import { Router } from "./router.js";
import { messagesForProvider } from "./messages.js";
import { type Message, type ProviderId } from "./types.js";
import {
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
} from "../providers/provider.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { toClaudeRequest } from "../providers/claude/convert.js";

function mock(id: ProviderId, model: string, scripts: ProviderEvent[][]) {
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    id,
    models: () => [{ id: model, contextTokens: null }],
    async *stream(req) {
      requests.push(structuredClone(req));
      yield* scripts.shift() ?? [];
    },
  };
  return { provider, requests };
}
const done: ProviderEvent = {
  type: "message_done",
  message: { role: "assistant", content: [{ type: "text", text: "pong" }] },
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1 },
};
const history: Message[] = [
  {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        provider: "claude",
        payload: {
          type: "thinking",
          thinking: "opaque",
          signature: "unchanged",
        },
      },
      {
        type: "reasoning",
        provider: "codex",
        payload: {
          type: "reasoning",
          encrypted_content: "opaque-codex",
          summary: [],
        },
      },
      { type: "text", text: "previous" },
    ],
  },
  { role: "user", content: [{ type: "text", text: "continue" }] },
];

describe("provider routing and append-only history", () => {
  it("filters the outgoing view and restores each provider's exact opaque blocks", () => {
    const before = structuredClone(history);
    for (const provider of ["claude", "codex"] as const) {
      const outgoing = messagesForProvider(history, provider);
      expect(
        outgoing[0]!.content.filter((b) => b.type === "reasoning"),
      ).toEqual(
        history[0]!.content.filter(
          (b) => b.type === "reasoning" && b.provider === provider,
        ),
      );
    }
    expect(history).toEqual(before);
    expect(
      messagesForProvider(
        [{ role: "assistant", content: [history[0]!.content[1]!] }],
        "claude",
      ),
    ).toEqual([]);
  });
  it("maps Codex tool IDs for Claude without mutating the recorded IDs", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_original",
            name: "Read",
            input: { path: "a" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "call_original", content: "ok" },
        ],
      },
    ];
    const native = toClaudeRequest({
      model: "claude-haiku-4-5",
      system: "",
      messages,
      tools: [],
    });
    expect(native.messages[0]!.content[0]!.id).toMatch(/^toolu_/);
    expect(native.messages[1]!.content[0]!.tool_use_id).toBe(
      native.messages[0]!.content[0]!.id,
    );
    expect(messages[0]!.content[0]).toMatchObject({ id: "call_original" });
  });
  it.each([3, 60])(
    "waits %i seconds then retries the same provider",
    async (seconds) => {
      const a = mock("claude", "claude-opus-5-5", [
        [{ type: "rate_limited", retryAfterSec: seconds }],
        [done],
      ]);
      const waits: number[] = [];
      const result = await runTurn(
        {
          provider: a.provider,
          model: "claude-opus-5-5",
          messages: history,
          system: "",
          tools: new Map(),
          permission: async () => true,
          sleep: async (ms) => {
            waits.push(ms);
          },
        },
        new AbortController().signal,
      );
      expect(waits).toEqual([seconds * 1000]);
      expect(a.requests).toHaveLength(2);
      expect(result.stopCause).toBe("end_turn");
    },
  );
  it.each([61, undefined])(
    "falls back for long or unknown waits and re-enters context",
    async (seconds) => {
      const a = mock("claude", "claude-opus-5-5", [
        [{ type: "rate_limited", retryAfterSec: seconds }],
      ]);
      const b = mock("codex", "gpt-6-luna", [[done]]);
      const steps: string[] = [];
      const result = await runTurn(
        {
          provider: a.provider,
          router: new Router([a.provider, b.provider], {
            claude: "codex:luna",
          }),
          model: "claude-opus-5-5",
          messages: history,
          system: "",
          tools: new Map(),
          permission: async () => true,
          onEvent: (e) => {
            if (e.type === "step") steps.push(e.step);
          },
        },
        new AbortController().signal,
      );
      expect(steps.slice(0, 4)).toEqual([
        "context",
        "model",
        "context",
        "model",
      ]);
      expect(b.requests).toHaveLength(1);
      expect(
        b.requests[0]!.messages[0]!.content.some(
          (c) => c.type === "reasoning" && c.provider === "claude",
        ),
      ).toBe(false);
      expect(result.messages.slice(0, 2)).toEqual(history);
      expect(result.receipts.some((r) => r.decision === "fallback")).toBe(true);
      expect(result.stopCause).toBe("end_turn");
    },
  );
  it("never cycles between exhausted providers", async () => {
    const a = mock("claude", "claude-opus-5-5", [
      [{ type: "rate_limited", retryAfterSec: 600 }],
    ]);
    const b = mock("codex", "gpt-6-luna", [
      [{ type: "rate_limited", retryAfterSec: 600 }],
    ]);
    const result = await runTurn(
      {
        provider: a.provider,
        router: new Router([a.provider, b.provider], {
          claude: "codex:luna",
          codex: "claude:opus",
        }),
        model: "claude-opus-5-5",
        messages: history,
        system: "",
        tools: new Map(),
        permission: async () => true,
      },
      new AbortController().signal,
    );
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
    expect(result.stopCause).toBe("rate_limited");
  });
  it("replays Codex text, encrypted reasoning, and function fixtures with FakeProvider", async () => {
    const provider = new FakeProvider({
      provider: "codex",
      script: [{ type: "fixture", name: "x4-gpt-6-luna-max" }],
    });
    const result = await runTurn(
      {
        provider,
        model: "gpt-6-luna",
        messages: [history[1]!],
        system: "",
        tools: new Map(),
        permission: async () => true,
      },
      new AbortController().signal,
    );
    expect(result.stopCause).toBe("end_turn");
    expect(
      result.messages
        .at(-1)!
        .content.some((b) => b.type === "reasoning" && b.provider === "codex"),
    ).toBe(true);
    const tool = new FakeProvider({
      provider: "codex",
      script: [
        { type: "fixture", name: "x3-tool-1" },
        { type: "fixture", name: "x3-tool-2" },
      ],
    });
    let executions = 0;
    const roundtrip = await runTurn(
      {
        provider: tool,
        model: "gpt-6-luna",
        messages: [history[1]!],
        system: "",
        tools: new Map([
          [
            "get_time",
            {
              spec: { name: "get_time", description: "time", inputSchema: {} },
              readOnly: true,
              validate: async () => undefined,
              execute: async () => {
                executions++;
                return { content: '{"now":"2026-10-01T00:00:00Z"}' };
              },
            },
          ],
        ]),
        permission: async () => true,
      },
      new AbortController().signal,
    );
    expect(executions).toBe(1);
    expect(roundtrip.stopCause).toBe("end_turn");
  });
});
