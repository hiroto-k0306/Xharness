import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { type SseEvent } from "../lib/sse.js";
import { assembleToolMessage, getTimeResult, probeTool } from "./tool.js";

async function rounds() {
  return JSON.parse(
    await readFile(
      new URL(
        "../../test/fixtures/claude/tool-roundtrip.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { events: SseEvent[][] };
}

it("assembles real get_time fragments and rejects unfinished blocks", async () => {
  const first = (await rounds()).events[0]!;
  expect(assembleToolMessage(first)).toMatchObject([
    { type: "tool_use", name: "get_time", input: { timezone: "Tokyo" } },
  ]);
  expect(() =>
    assembleToolMessage(
      first.filter((event) => event.event !== "content_block_stop"),
    ),
  ).toThrow("Incomplete");
});

it("returns an unambiguous date and accepts the observed Tokyo alias", () => {
  expect(getTimeResult("Tokyo", new Date("2026-10-01T03:21:02Z"))).toEqual({
    timezone: "Asia/Tokyo",
    utc: "2026-10-01T03:21:02.000Z",
    localTime: "2026-10-01 12:21:02",
  });
});

it("resumes the saved tool call with its original ID using only one request", async () => {
  const recorded = (await rounds()).events;
  const root = await mkdtemp(join(tmpdir(), "xharness-tool-"));
  let requests = 0;
  try {
    const result = await probeTool("fake-private-access", {
      root,
      first: { ok: true, status: 200, events: recorded[0]! },
      fetcher: async (_url, options) => {
        requests++;
        const body = JSON.parse(options!.body as string) as {
          messages: {
            content: { id?: string; tool_use_id?: string; content?: string }[];
          }[];
        };
        expect(body.messages[1]!.content[0]!.id).toBe(
          body.messages[2]!.content[0]!.tool_use_id,
        );
        expect(
          JSON.parse(body.messages[2]!.content[0]!.content!),
        ).toHaveProperty("utc");
        const wire = recorded[1]!
          .map((event) => `event: ${event.event}\ndata: ${event.data}\n\n`)
          .join("");
        return new Response(wire, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    expect(requests).toBe(1);
    expect(result.success).toBe(true);
    expect(
      await readFile(
        join(root, "test/fixtures/claude/tool-roundtrip.json"),
        "utf8",
      ),
    ).not.toContain("fake-private-access");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
