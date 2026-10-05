import { expect, it, vi } from "vitest";
import { TurnEvents } from "./turn-events.js";
import { createRuntime, type ControllerContext } from "./context.js";

function events() {
  const ctx = {
    options: {
      provider: { id: "claude" },
      emit: vi.fn(),
      quotaNow: () => 1000,
    },
    quota: {},
    usage: {},
    clean: (s: string) => s,
    sessions: new Map(),
    receipts: { append: async () => {} },
  } as unknown as ControllerContext;
  return new TurnEvents(
    ctx,
    { id: "session", model: "model" } as never,
    createRuntime(),
  );
}
it("partial output and fallback block safe quota continuation", () => {
  const partial = events();
  partial.onEvent({ type: "text_delta", text: "partial" });
  partial.onEvent({ type: "rate_limited", retryAfterSec: 120 });
  expect(partial.resumeUnsafe).toBe(true);
  const fallback = events();
  fallback.onEvent({
    type: "receipt",
    receipt: {
      provider: "claude",
      decision: "fallback",
      model: "model",
      round: 1,
      startedAt: "",
      completedAt: "",
    },
  });
  fallback.onEvent({ type: "rate_limited", retryAfterSec: 120 });
  expect(fallback.resumeUnsafe).toBe(true);
});
it("never uses quota headers from a previous model attempt", () => {
  const e = events();
  e.onEvent({
    type: "usage",
    provider: "claude",
    windows: [
      {
        name: "week",
        windowMinutes: 10080,
        usedPercent: 100,
        resetAt: new Date(999000).toISOString(),
      },
    ],
  });
  e.onEvent({ type: "step", step: "model", round: 2 });
  e.onEvent({ type: "rate_limited" });
  expect(e.quotaRate?.windows).toBeUndefined();
  expect(e.resumeUnsafe).toBe(false);
});
