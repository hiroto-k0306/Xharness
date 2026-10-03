import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { type ProviderEvent } from "../provider.js";
import { decodeClaudeStream } from "./stream.js";

type SseEvent = { event: string; data: string };
function response(events: SseEvent[]) {
  return new Response(
    events.map((e) => `event: ${e.event}\r\ndata: ${e.data}\r\n\r\n`).join(""),
  );
}
async function gather(events: SseEvent[]) {
  const result: ProviderEvent[] = [];
  for await (const event of decodeClaudeStream(response(events)))
    result.push(event);
  return result;
}
async function truncatedFixture() {
  return (
    JSON.parse(
      await readFile(
        "test/fixtures/claude/max-tokens-truncated-tool-use.json",
        "utf8",
      ),
    ) as { events: SseEvent[] }
  ).events;
}
function sse(data: Record<string, unknown>): SseEvent {
  return { event: String(data.type), data: JSON.stringify(data) };
}
function done(events: ProviderEvent[]) {
  const result = events.find((e) => e.type === "message_done");
  if (!result || result.type !== "message_done")
    throw new Error("Expected completion");
  return result;
}

describe("Claude stream cut by max_tokens", () => {
  it("drops the unfinished tool_use and completes with max_tokens", async () => {
    const events = await gather(await truncatedFixture());
    expect(events.some((e) => e.type === "tool_use")).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(false);
    const completion = done(events);
    expect(completion.stopReason).toBe("max_tokens");
    expect(completion.usage).toMatchObject({ outputTokens: 4096 });
    expect(completion.message.content).toEqual([
      {
        type: "reasoning",
        provider: "claude",
        payload: {
          type: "thinking",
          thinking: "Plan the work.",
          signature: "opaque",
        },
      },
      { type: "text", text: "Submitting the plan." },
    ]);
  });
  it("keeps the text written so far in an unfinished text block", async () => {
    const recorded = await truncatedFixture();
    const events = await gather([
      recorded[0]!,
      sse({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      sse({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "partial answer" },
      }),
      recorded.at(-2)!,
      recorded.at(-1)!,
    ]);
    expect(done(events).stopReason).toBe("max_tokens");
    expect(done(events).message.content).toEqual([
      { type: "text", text: "partial answer" },
    ]);
  });
  it("drops an unfinished reasoning block whose signature may be incomplete", async () => {
    const recorded = await truncatedFixture();
    const events = await gather([
      recorded[0]!,
      recorded[1]!,
      recorded[2]!,
      recorded.at(-2)!,
      recorded.at(-1)!,
    ]);
    expect(done(events).message.content).toEqual([]);
    expect(done(events).stopReason).toBe("max_tokens");
  });
  it("still rejects an unfinished block for any other stop reason", async () => {
    const recorded = await truncatedFixture();
    const events = recorded.map((e) =>
      e.event === "message_delta"
        ? sse({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 10 },
          })
        : e,
    );
    await expect(gather(events)).rejects.toThrow("Invalid message delta");
  });
});
