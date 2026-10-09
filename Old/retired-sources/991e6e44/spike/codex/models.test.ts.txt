import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { readCatalog } from "./models.js";
import { maskSecrets } from "../lib/mask.js";

it("reads actual model metadata without treating advertised efforts as verified requests", async () => {
  const saved = JSON.parse(
    await readFile(
      new URL("../../test/fixtures/codex/x5-models.json", import.meta.url),
      "utf8",
    ),
  ) as { body: unknown };
  const body: unknown =
    typeof saved.body === "string" ? JSON.parse(saved.body) : saved.body;
  const models = readCatalog(body);
  expect(models).toHaveLength(10);
  const luna = models.find((model) => model.slug === "gpt-6-luna")!;
  expect(luna.context_window).toBe(272000);
  expect(luna.supported_reasoning_levels?.map((level) => level.effort)).toEqual(
    ["low", "medium", "high", "xhigh", "max"],
  );
  expect(readCatalog(maskSecrets(body))).toEqual(models);
});

it("rejects missing catalogs and malformed entries", () => {
  expect(() => readCatalog({})).toThrow("Invalid catalog response");
  expect(() => readCatalog({ models: [{ slug: 12 }] })).toThrow(
    "Invalid model entry",
  );
});

it("preserves public token budget numbers but masks secret values nested in metadata", () => {
  const safe = maskSecrets({
    token_budget: {
      reminder_threshold_tokens: 100,
      auto_compact_fallback_buffer_tokens: 20,
      access_token: "fake-secret-value",
    },
    auto_compact_token_limit: 200,
    max_output_tokens: "fake-output-secret",
  });
  expect(safe).toMatchObject({
    token_budget: {
      reminder_threshold_tokens: 100,
      auto_compact_fallback_buffer_tokens: 20,
    },
    auto_compact_token_limit: 200,
  });
  expect(JSON.stringify(safe)).not.toContain("fake-secret-value");
  expect(JSON.stringify(safe)).not.toContain("fake-output-secret");
});
