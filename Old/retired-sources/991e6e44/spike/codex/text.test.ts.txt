import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { summarizeCodexText } from "./text.js";
import { type SseEvent } from "../lib/sse.js";
import { sendProbe } from "../lib/probe.js";
import { inspectHeaders } from "../lib/headers.js";

async function fixture(model: string) {
  return JSON.parse(
    await readFile(
      new URL(`../../test/fixtures/codex/x2-${model}.json`, import.meta.url),
      "utf8",
    ),
  ) as { events: SseEvent[] };
}

it("extracts actual Codex percentages and their window lengths", async () => {
  const saved = JSON.parse(
    await readFile(
      new URL("../../test/fixtures/codex/x2-gpt-6-luna.json", import.meta.url),
      "utf8",
    ),
  ) as {
    responseHeaders: { all: Record<string, string> };
  };
  const usage = inspectHeaders(new Headers(saved.responseHeaders.all)).usage;
  expect(usage["x-codex-primary-used-percent"]).toBe("19");
  expect(usage["x-codex-primary-window-minutes"]).toBe("300");
  expect(usage["x-codex-secondary-used-percent"]).toBe("7");
  expect(usage["x-codex-secondary-window-minutes"]).toBe("10080");
});

it.each(["gpt-6-luna", "gpt-6-1-sol", "gpt-6-astra"])(
  "assembles real %s SSE and detects missing completion",
  async (model) => {
    const recorded = await fixture(model);
    expect(summarizeCodexText(recorded.events)).toMatchObject({
      text: "pong",
      completed: true,
      failed: false,
    });
    expect(summarizeCodexText(recorded.events.slice(0, -1)).completed).toBe(
      false,
    );
    expect(
      summarizeCodexText([
        ...recorded.events,
        { event: "error", data: '{"type":"error"}' },
      ]).failed,
    ).toBe(true);
  },
);

it("recognizes real SSE without Content-Type and preserves counters without credentials", async () => {
  const recorded = await fixture("gpt-6-luna");
  const wire = recorded.events
    .map((event) => `event: ${event.event}\ndata: ${event.data}\n\n`)
    .join("");
  const root = await mkdtemp(join(tmpdir(), "xharness-codex-"));
  try {
    const result = await sendProbe({
      provider: "codex",
      name: "replay",
      url: "https://chatgpt.com/backend-api/codex/responses",
      headers: new Headers({
        authorization: "Bearer fake-private-access",
        "chatgpt-account-id": "fake-account-id",
      }),
      body: {},
      secrets: ["fake-private-access", "fake-account-id"],
      root,
      fetcher: async () => new Response(new TextEncoder().encode(wire)),
    });
    expect(result.responseHeaders.has("content-type")).toBe(false);
    expect(summarizeCodexText(result.events).completed).toBe(true);
    const saved = await readFile(
      join(root, "test/fixtures/codex/replay.json"),
      "utf8",
    );
    expect(saved).not.toContain("fake-private-access");
    expect(saved).not.toContain("chatgpt-account-id");
    expect(saved).not.toContain("authorization");
    const parsed = JSON.parse(saved) as { events: SseEvent[] };
    const completed = JSON.parse(parsed.events.at(-1)!.data) as {
      response: { usage: { input_tokens: number; output_tokens: number } };
    };
    expect(completed.response.usage.input_tokens).toBe(23);
    expect(completed.response.usage.output_tokens).toBe(5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
