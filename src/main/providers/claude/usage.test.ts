import { expect, it } from "vitest";
import { claudeUsage } from "./usage.js";
it("normalizes Claude quota ratios, preserves missing values and returns ISO resets", () => {
  expect(claudeUsage(new Headers()).windows).toEqual([]);
  const result = claudeUsage(
    new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0",
      "anthropic-ratelimit-unified-7d-utilization": "0.84",
      "anthropic-ratelimit-unified-7d-reset": "1791115200",
    }),
  );
  expect(result.windows[0]?.usedPercent).toBe(0);
  expect(result.windows[1]?.usedPercent).toBe(84);
  expect(result.windows[1]?.resetAt).toMatch(/Z$/);
  expect(
    claudeUsage(
      new Headers({ "anthropic-ratelimit-unified-5h-reset": "1e100" }),
    ).windows[0]?.resetAt,
  ).toBeUndefined();
});
