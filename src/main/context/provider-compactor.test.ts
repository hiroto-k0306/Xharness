import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { prepareProviderHistory } from "./provider-compactor.js";
import { ClaudeAdapter } from "../providers/claude/adapter.js";
import { CodexAdapter } from "../providers/codex/adapter.js";
import { toClaudeRequest } from "../providers/claude/convert.js";
import { type Message } from "../core/types.js";
const user = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});
const history: Message[] = [
  user("old"),
  {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        provider: "claude",
        payload: {
          type: "thinking",
          thinking: "unchanged",
          signature: "opaque",
        },
      },
      { type: "text", text: "answer" },
    ],
  },
  user("recent"),
  { role: "assistant", content: [{ type: "text", text: "answer2" }] },
  user("latest"),
];
const options = {
  model: "claude-opus-5-5",
  system: "same system",
  tools: [],
  threshold: 0.8,
  force: true,
  signal: new AbortController().signal,
};
it("uses signed server compaction and returns it unmodified without rewriting saved thinking", async () => {
  const native = JSON.parse(
    await readFile("test/fixtures/stabilize/claude-compaction.json", "utf8"),
  );
  const sse = [
    {
      type: "message_start",
      message: { model: native.model, usage: native.usage },
    },
    { type: "content_block_start", index: 0, content_block: native.content[0] },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: native.stop_reason },
      usage: native.usage,
    },
    { type: "message_stop" },
  ]
    .map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`)
    .join("");
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(sse));
  const provider = new ClaudeAdapter({
    getAccessToken: async () => "test",
    fetcher,
  });
  const before = structuredClone(history);
  const result = await prepareProviderHistory(history, {
    ...options,
    provider,
    checkpoint: { covered: 2, summary: "unsafe legacy summary" },
  });
  expect(result.checkpoint?.provider).toBe("claude");
  expect(result.checkpoint?.covered).toBe(4);
  const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
  expect(body.compaction).toEqual({ type: "summarize" });
  expect(body.system[1].text).toBe("same system");
  expect(
    new Headers(fetcher.mock.calls[0]![1]!.headers).get("anthropic-beta"),
  ).toContain("compact-2026-09-04");
  const resumed = toClaudeRequest({
    ...options,
    messages: result.messages,
    tools: [],
  });
  expect(resumed.messages[0]!.content[0]).toEqual(native.content[0]);
  expect(result.messages.at(-1)).toEqual(history.at(-1));
  expect(history).toEqual(before);
});
it("summarizes Codex through Luna using the real SSE fixture and reuses its checkpoint", async () => {
  const sse = await readFile(
    "test/fixtures/stabilize/codex-summary.sse",
    "utf8",
  );
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(sse));
  const provider = new CodexAdapter({
    fetcher,
    getCredentials: async () => ({ accessToken: "test", accountId: "test" }),
  });
  const result = await prepareProviderHistory(history, {
    ...options,
    provider,
    model: "gpt-6.1-sol",
  });
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).model).toBe(
    "gpt-6-luna",
  );
  expect(result.checkpoint?.summary).toContain("add");
  expect(result.messages.slice(1)).toEqual(history.slice(2));
  const reused = await prepareProviderHistory(history, {
    ...options,
    provider,
    model: "gpt-6.1-sol",
    force: false,
    checkpoint: result.checkpoint,
  });
  expect(reused.compacted).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("keeps history unchanged on a failed compaction and never client-compacts Haiku", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("", { status: 400 }));
  const provider = new ClaudeAdapter({
    fetcher,
    getAccessToken: async () => "test",
  });
  const before = structuredClone(history);
  await expect(
    prepareProviderHistory(history, { ...options, provider }),
  ).rejects.toThrow("original history retained");
  expect(history).toEqual(before);
  await expect(
    prepareProviderHistory(history, {
      ...options,
      provider,
      model: "claude-haiku-4-5-20251001",
    }),
  ).rejects.toThrow("unavailable");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
