import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { outputItems, probeCodexTool } from "./tool.js";
import { type SseEvent } from "../lib/sse.js";

async function fixture(round: number, suffix = ""): Promise<SseEvent[]> {
  const saved = JSON.parse(
    await readFile(
      new URL(
        `../../test/fixtures/codex/x3-tool-${round}${suffix}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { events: SseEvent[] };
  return saved.events;
}

it.each(["high", "max"] as const)(
  "replays the actual %s function call unchanged and matches its result by call_id",
  async (effort) => {
    const suffix = effort === "high" ? "" : "-max";
    const first = await fixture(1, suffix);
    const second = await fixture(2, suffix);
    const items = outputItems(first);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "function_call", name: "get_time" });
    expect(JSON.parse(items[0]!.arguments!)).toEqual({
      timezone: "Asia/Tokyo",
    });
    const root = await mkdtemp(join(tmpdir(), "xharness-codex-tool-"));
    const requests: { input: Record<string, unknown>[] }[] = [];
    try {
      const result = await probeCodexTool(
        { accessToken: "fake-access-value", accountId: "fake-account-value" },
        {
          root,
          effort,
          fetcher: async (_url, init) => {
            requests.push(
              JSON.parse(String(init?.body)) as {
                input: Record<string, unknown>[];
              },
            );
            const events = requests.length === 1 ? first : second;
            return new Response(
              events
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
      expect(requests).toHaveLength(2);
      expect(requests[1]!.input.slice(1, -1)).toEqual(items);
      const output = requests[1]!.input.at(-1)!;
      expect(output).toMatchObject({
        type: "function_call_output",
        call_id: items[0]!.call_id,
      });
      expect(JSON.parse(output.output as string)).toMatchObject({
        timezone: "Asia/Tokyo",
      });
      const saved = await readFile(
        join(root, `test/fixtures/codex/x3-tool-2${suffix}.json`),
        "utf8",
      );
      expect(saved).not.toContain("fake-access-value");
      expect(saved).not.toContain("fake-account-value");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("rejects an incomplete output item instead of sending an invalid history", () => {
  expect(() =>
    outputItems([
      {
        event: "response.output_item.done",
        data: '{"type":"response.output_item.done","item":{}}',
      },
    ]),
  ).toThrow("Invalid output item");
});
