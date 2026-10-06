import { expect, it } from "vitest";
import { normalizeTokens, tokenMeasurement } from "./token-usage.js";
import { decodeCodexStream } from "./codex/stream.js";
import { decodeClaudeStream } from "./claude/stream.js";

it("preserves OpenAI subsets without double counting cache or reasoning", () => {
  const measured = tokenMeasurement("codex", {
    input_tokens: 100,
    output_tokens: 40,
    input_tokens_details: { cached_tokens: 80 },
    output_tokens_details: { reasoning_tokens: 30 },
    secret: "not retained",
  });
  expect(normalizeTokens(measured)).toEqual({
    input: 100,
    output: 40,
    cacheRead: 80,
    cacheWrite: null,
    reasoning: 30,
    total: 140,
  });
  expect(measured.raw).not.toHaveProperty("secret");
});
it("adds separate Anthropic cache and retains iterations once", () => {
  const raw = {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 50,
  };
  expect(normalizeTokens(tokenMeasurement("claude", raw)).total).toBe(180);
  expect(
    normalizeTokens(
      tokenMeasurement("claude", { ...raw, iterations: [raw, raw] }),
    ),
  ).toEqual({
    input: 320,
    output: 40,
    cacheRead: 200,
    cacheWrite: 100,
    reasoning: null,
    total: 360,
  });
});
it("does not invent missing, negative or invalid values; measured zero remains zero", () => {
  expect(
    normalizeTokens(
      tokenMeasurement("claude", { input_tokens: 0, output_tokens: 0 }),
    ).total,
  ).toBeNull();
  expect(
    normalizeTokens(
      tokenMeasurement("codex", { input_tokens: 0, output_tokens: 0 }),
    ).total,
  ).toBe(0);
  expect(
    normalizeTokens(
      tokenMeasurement("codex", { input_tokens: -1, output_tokens: "10" }),
    ).total,
  ).toBeNull();
});

it("retains measured reasoning and missing cache through the Codex decoder", async () => {
  const data = {
    type: "response.completed",
    response: {
      status: "completed",
      model: "fixture",
      output: [],
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        input_tokens_details: {},
        output_tokens_details: { reasoning_tokens: 30 },
      },
    },
  };
  const events = [];
  for await (const event of decodeCodexStream(
    new Response(`data: ${JSON.stringify(data)}\n\n`),
  ))
    events.push(event);
  const done = events.find((e) => e.type === "message_done")!;
  expect(done.usage.reasoningTokens).toBe(30);
  expect(normalizeTokens(done.usage.measurement!)).toEqual({
    input: 100,
    output: 40,
    cacheRead: null,
    cacheWrite: null,
    reasoning: 30,
    total: 140,
  });
});
it("merges Anthropic start/delta snapshots and uses native iteration cache once", async () => {
  const events = [
    {
      type: "message_start",
      message: {
        model: "fixture",
        usage: {
          input_tokens: 999,
          output_tokens: 0,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 3,
        },
      },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        output_tokens: 5,
        iterations: [
          {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 3,
          },
          {
            input_tokens: 20,
            output_tokens: 6,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 5,
          },
        ],
      },
    },
    { type: "message_stop" },
  ];
  const decoded = [];
  for await (const event of decodeClaudeStream(
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")),
  ))
    decoded.push(event);
  const done = decoded.find((e) => e.type === "message_done")!;
  expect(done.usage).toMatchObject({
    inputTokens: 30,
    outputTokens: 11,
    cacheReadTokens: 6,
    cacheWriteTokens: 8,
  });
  expect(normalizeTokens(done.usage.measurement!).total).toBe(55);
});
