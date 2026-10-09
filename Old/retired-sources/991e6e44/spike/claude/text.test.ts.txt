import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reserveRequest } from "../lib/budget.js";
import { type SseEvent } from "../lib/sse.js";
import { probeText, summarizeText } from "./text.js";

async function fixture(name: string) {
  return JSON.parse(
    await readFile(
      new URL(`../../test/fixtures/claude/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as {
    status: number;
    events: SseEvent[];
    body?: string;
    requestBody?: { max_tokens: unknown; model: string };
    responseHeaders: {
      all: Record<string, string>;
      usage: Record<string, string>;
    };
  };
}

describe("Claude text probe", () => {
  it("replays actual Opus SSE with the C2 step 2 identity system", async () => {
    const recorded = await fixture("c2-opus-identity");
    expect(recorded.status).toBe(200);
    const root = await mkdtemp(join(tmpdir(), "xharness-opus-identity-"));
    try {
      const result = await probeText(
        "fake-private-access",
        "claude-opus-5-5",
        "identity",
        {
          root,
          fetcher: async (_url, init) => {
            const body = JSON.parse(String(init?.body)) as {
              system: unknown[];
              max_tokens: number;
              model: string;
            };
            expect(body.system).toEqual([
              {
                type: "text",
                text: "You are Claude Code, Anthropic's official CLI for Claude.",
              },
            ]);
            expect(body.max_tokens).toBe(64);
            expect(body.model).toBe("claude-opus-5-5");
            return new Response(
              recorded.events
                .map(
                  (event) => `event: ${event.event}\ndata: ${event.data}\n\n`,
                )
                .join(""),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        },
      );
      expect(result.success).toBe(true);
      expect(summarizeText(recorded.events)).toMatchObject({
        text: "pong",
        stopReason: "end_turn",
        complete: true,
      });
      const saved = await readFile(
        join(root, "test/fixtures/claude/c2-opus-identity.json"),
        "utf8",
      );
      expect(saved).not.toContain("fake-private-access");
      expect(saved).not.toContain("authorization");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("assembles real Haiku deltas and rejects incomplete or error streams", async () => {
    const recorded = await fixture("c2-haiku-none");
    expect(recorded.requestBody).toMatchObject({
      max_tokens: 64,
      model: "claude-haiku-4-5-20251001",
    });
    expect(
      recorded.responseHeaders.usage[
        "anthropic-ratelimit-unified-5h-utilization"
      ],
    ).toBe("0.3");
    expect(recorded.responseHeaders.all).not.toHaveProperty(
      "anthropic-organization-id",
    );
    expect(recorded.responseHeaders.all).not.toHaveProperty(
      "anthropic-workspace-id",
    );
    expect(summarizeText(recorded.events)).toMatchObject({
      text: "pong",
      stopReason: "end_turn",
      complete: true,
    });
    expect(summarizeText(recorded.events.slice(0, -1)).complete).toBe(false);
    expect(
      summarizeText([...recorded.events, { event: "error", data: "{}" }])
        .complete,
    ).toBe(false);
    expect(
      summarizeText([{ event: "message_stop", data: "invalid" }]).complete,
    ).toBe(false);
  });

  it.each(["c2-opus-none", "c2-opus-none-recheck"])(
    "records the real %s 429 response without retrying or retaining echoed credentials",
    async (name) => {
      const recorded = await fixture(name);
      const root = await mkdtemp(join(tmpdir(), "xharness-probe-"));
      let requests = 0;
      try {
        const result = await probeText(
          "fake-private-access",
          "claude-opus-5-5",
          "none",
          {
            root,
            fetcher: async () => {
              requests++;
              return new Response(recorded.body, { status: recorded.status });
            },
          },
        );
        expect(requests).toBe(1);
        expect(result.success).toBe(false);
        const saved = await readFile(
          join(root, "test/fixtures/claude/c2-opus-none.json"),
          "utf8",
        );
        expect(saved).toContain("rate_limit_error");
        expect(saved).not.toContain("fake-private-access");
        expect(saved).not.toContain("authorization");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not persist or return a secret echoed by a transport exception", async () => {
    const root = await mkdtemp(join(tmpdir(), "xharness-probe-"));
    try {
      const result = await probeText(
        "fake-private-access",
        "claude-haiku-4-5-20251001",
        "none",
        {
          root,
          fetcher: async () => {
            throw new Error("Bearer fake-private-access");
          },
        },
      );
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).not.toContain("fake-private-access");
      const saved = await readFile(
        join(root, "test/fixtures/claude/c2-haiku-none.json"),
        "utf8",
      );
      expect(saved).toContain("transport_error");
      expect(saved).not.toContain("fake-private-access");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("reserves at most 20 Claude requests even with concurrent callers and restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "xharness-budget-"));
  try {
    const reservations = await Promise.all(
      Array.from({ length: 20 }, () => reserveRequest("claude", "test", root)),
    );
    expect(new Set(reservations).size).toBe(20);
    await expect(reserveRequest("claude", "test", root)).rejects.toThrow(
      "exhausted",
    );
    expect(await reserveRequest("codex", "test", root)).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
