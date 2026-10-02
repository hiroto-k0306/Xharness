import { describe, expect, it } from "vitest";
import { type ControllerContext } from "./context.js";
import { updateQuota, usageEvent } from "./turn-events.js";

describe("usage tracking for Web auto (§22.2)", () => {
  it("keeps the latest value per window and does not drop windows missing from a later event", () => {
    const ctx = { quota: {}, usage: {} } as unknown as ControllerContext;
    updateQuota(ctx, {
      type: "usage",
      provider: "claude",
      windows: [
        { name: "5h", windowMinutes: 300, usedPercent: 10, resetAt: "a" },
        { name: "7d", windowMinutes: 10080, usedPercent: 80, resetAt: "b" },
      ],
    });
    usageEvent(ctx, {
      type: "usage",
      provider: "claude",
      windows: [{ name: "5h", windowMinutes: 300, usedPercent: 20 }],
    });
    expect(ctx.quota).toEqual({ claude: 20 });
    expect(ctx.usage.claude).toEqual([
      { name: "5h", windowMinutes: 300, usedPercent: 20 },
      { name: "7d", windowMinutes: 10080, usedPercent: 80, resetAt: "b" },
    ]);
  });
});
