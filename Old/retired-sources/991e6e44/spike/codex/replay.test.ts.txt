import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { encryptedReplayInput, probeEncryptedReplay } from "./replay.js";
import { outputItems } from "./tool.js";
import { type SseEvent } from "../lib/sse.js";

it("preserves actual encrypted reasoning and native message items when replaying a completed turn", async () => {
  const first = JSON.parse(
    await readFile(
      new URL(
        "../../test/fixtures/codex/x4-gpt-6-luna-max.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { requestBody: { input: unknown[] }; events: SseEvent[] };
  const second = JSON.parse(
    await readFile(
      new URL(
        "../../test/fixtures/codex/x3-encrypted-replay.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { requestBody: { input: unknown[] }; events: SseEvent[] };
  const input = encryptedReplayInput(first);
  expect(input.slice(first.requestBody.input.length, -1)).toEqual(
    outputItems(first.events),
  );
  expect(second.requestBody.input).toEqual(input);
  expect(() =>
    encryptedReplayInput({ ...first, events: first.events.slice(0, -1) }),
  ).toThrow("Incomplete saved response");
  expect(() => encryptedReplayInput({ ...first, events: [] })).toThrow(
    "No encrypted reasoning",
  );
  const root = await mkdtemp(join(tmpdir(), "xharness-encrypted-"));
  try {
    const result = await probeEncryptedReplay(
      { accessToken: "fake-access-value", accountId: "fake-account-value" },
      first,
      {
        root,
        fetcher: async (_url, init) => {
          expect(
            (JSON.parse(String(init?.body)) as { input: unknown[] }).input,
          ).toEqual(input);
          return new Response(
            second.events
              .map((event) => `event: ${event.event}\ndata: ${event.data}\n\n`)
              .join(""),
          );
        },
      },
    );
    expect(result.success).toBe(true);
    const recorded = await readFile(
      join(root, "test/fixtures/codex/x3-encrypted-replay.json"),
      "utf8",
    );
    expect(recorded).not.toContain("fake-access-value");
    expect(recorded).not.toContain("fake-account-value");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
