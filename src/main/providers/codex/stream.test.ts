import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { type ProviderEvent } from "../provider.js";
import { decodeCodexStream } from "./stream.js";

const recorded = JSON.parse(
  await readFile("test/fixtures/codex/stream-error.json", "utf8"),
) as {
  payload: {
    type: string;
    error: { type: string; code: string; message: string };
  };
};
function sse(data: unknown[]) {
  return new Response(
    data.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""),
  );
}
async function collect(payload: unknown): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of decodeCodexStream(sse([payload])))
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
      // Malformed input must produce a structured decoder error.
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
});
