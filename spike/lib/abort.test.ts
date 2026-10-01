import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { probeAbort } from "./abort.js";
import { type SseEvent } from "./sse.js";
import { summarizeText } from "../claude/text.js";
import { summarizeCodexText } from "../codex/text.js";

it.each(["claude", "codex"] as const)(
  "keeps actual partial %s events and does not report completion",
  async (provider) => {
    const saved = JSON.parse(
      await readFile(
        new URL(
          `../../test/fixtures/${provider}/r2-abort.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      events: SseEvent[];
      body: { observation: { exceptionName: string } };
    };
    expect(saved.body.observation.exceptionName).toBe("AbortError");
    if (provider === "claude")
      expect(summarizeText(saved.events).complete).toBe(false);
    else expect(summarizeCodexText(saved.events).completed).toBe(false);
    const root = await mkdtemp(join(tmpdir(), "xharness-abort-"));
    try {
      const result = await probeAbort({
        provider,
        url: "https://example.invalid/stream",
        body: {},
        root,
        headers: new Headers({
          authorization: "Bearer fake-access-value",
          "chatgpt-account-id": "fake-account-value",
        }),
        secrets: ["fake-access-value", "fake-account-value"],
        fetcher: async (_url, init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    saved.events
                      .map(
                        (event) =>
                          `event: ${event.event}\ndata: ${event.data}\n\n`,
                      )
                      .join(""),
                  ),
                );
                init?.signal?.addEventListener(
                  "abort",
                  () =>
                    controller.error(
                      new DOMException("fake-access-value", "AbortError"),
                    ),
                  { once: true },
                );
              },
            }),
          ),
      });
      expect(result).toMatchObject({
        status: 200,
        requestedAbort: true,
        exceptionName: "AbortError",
        eventCount: saved.events.length,
      });
      const recorded = await readFile(
        join(root, `test/fixtures/${provider}/r2-abort.json`),
        "utf8",
      );
      const parsed = JSON.parse(recorded) as { events: SseEvent[] };
      expect(parsed.events).toEqual(saved.events);
      expect(recorded).not.toContain("fake-access-value");
      expect(recorded).not.toContain("fake-account-value");
      expect(recorded).not.toContain("authorization");
      expect(recorded).not.toContain("chatgpt-account-id");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("does not leak arbitrary exception names or classify a fetch failure as a requested abort", async () => {
  const root = await mkdtemp(join(tmpdir(), "xharness-abort-error-"));
  try {
    const result = await probeAbort({
      provider: "codex",
      url: "https://example.invalid",
      headers: new Headers(),
      body: {},
      secrets: [],
      root,
      fetcher: async () => {
        const error = new Error("fake-secret-message");
        error.name = "fake-secret-name";
        throw error;
      },
    });
    expect(result).toMatchObject({
      status: 0,
      requestedAbort: false,
      exceptionName: "UnknownError",
      eventCount: 0,
    });
    const saved = await readFile(
      join(root, "test/fixtures/codex/r2-abort.json"),
      "utf8",
    );
    expect(saved).not.toContain("fake-secret-message");
    expect(saved).not.toContain("fake-secret-name");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
