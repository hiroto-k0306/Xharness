import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { probeEffort } from "./effort.js";
import { type SseEvent } from "../lib/sse.js";
import { outputItems } from "./tool.js";

const cases = [
  ["gpt-6.1-sol", "low"],
  ["gpt-6.1-sol", "medium"],
  ["gpt-6.1-sol", "xhigh"],
  ["gpt-6.1-sol", "max"],
  ["gpt-6-astra", "low"],
  ["gpt-6-astra", "max"],
  ["gpt-6-luna", "low"],
  ["gpt-6-luna", "max"],
] as const;

it.each(cases)(
  "replays actual %s / %s with the requested wire effort",
  async (model, effort) => {
    const saved = JSON.parse(
      await readFile(
        new URL(
          `../../test/fixtures/codex/x4-${model.replaceAll(".", "-")}-${effort}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { events: SseEvent[]; requestBody: { reasoning: { effort: string } } };
    expect(saved.requestBody.reasoning.effort).toBe(effort);
    if (effort === "max") {
      const reasoning = outputItems(saved.events).find(
        (item) => item.type === "reasoning",
      );
      expect(typeof reasoning?.encrypted_content).toBe("string");
      expect(reasoning?.encrypted_content).not.toBe("");
    }
    const root = await mkdtemp(join(tmpdir(), "xharness-effort-"));
    let calls = 0;
    try {
      const result = await probeEffort(
        { accessToken: "fake-access-value", accountId: "fake-account-value" },
        model,
        effort,
        {
          root,
          fetcher: async (_url, init) => {
            calls++;
            const body = JSON.parse(String(init?.body)) as {
              reasoning: { effort: string };
            };
            expect(body.reasoning.effort).toBe(effort);
            return new Response(
              saved.events
                .map(
                  (event) => `event: ${event.event}\ndata: ${event.data}\n\n`,
                )
                .join(""),
            );
          },
        },
      );
      expect(result.success).toBe(true);
      expect(calls).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("rejects UI aliases before sending an unsupported wire effort", async () => {
  let calls = 0;
  await expect(
    probeEffort(
      { accessToken: "fake", accountId: "fake" },
      "gpt-6.1-sol",
      "ultra",
      {
        fetcher: async () => {
          calls++;
          return new Response();
        },
      },
    ),
  ).rejects.toThrow("Unsupported effort probe");
  expect(calls).toBe(0);
});
