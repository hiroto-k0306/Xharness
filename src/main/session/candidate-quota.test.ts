import { expect, it } from "vitest";
import { CandidateQuotas, QUOTA_FRESH_MS } from "./candidate-quota.js";
it("preserves per-window age, unknown fields, reset uncertainty and shared exhaustion without token inference", () => {
  const q = new CandidateQuotas();
  expect(q.view("claude", 1000).state).toBe("unknown");
  q.observe(
    "claude",
    [{ name: "week", usedPercent: 100, windowMinutes: 10080 }],
    1000,
    false,
  );
  expect(q.view("claude", 1001)).toMatchObject({
    state: "exhausted",
    scope: "provider-pool-unknown",
    observedAt: 1000,
  });
  q.observe(
    "claude",
    [{ name: "5h", usedPercent: 10, windowMinutes: 300 }],
    QUOTA_FRESH_MS + 2000,
    false,
  );
  const later = q.view("claude", QUOTA_FRESH_MS + 2001);
  expect(later.state).toBe("observed");
  expect(later.reasons.join(" ")).toContain("古い");
  q.observe(
    "claude",
    [{ name: "5h", windowMinutes: 300 }],
    QUOTA_FRESH_MS + 3000,
    false,
  );
  expect(q.view("claude", QUOTA_FRESH_MS + 3001).state).toBe("stale");
  q.observe(
    "codex",
    [{ name: "week", usedPercent: 100, resetAt: new Date(2000).toISOString() }],
    1000,
    false,
  );
  expect(q.view("codex", 2001).state).toBe("stale"); // reset does not prove recovery
});
it("never uses mock quota as production availability and treats stale or future failures conservatively", () => {
  const q = new CandidateQuotas();
  q.observe("claude", [{ name: "5h", usedPercent: 100 }], 1000, true);
  q.limited("claude", 1000, true, 600);
  expect(q.view("claude", 1001).state).toBe("simulated");
  q.limited("codex", 1000, false, 600);
  expect(q.view("codex", 1001).state).toBe("exhausted");
  expect(q.view("codex", QUOTA_FRESH_MS + 1001).state).toBe("stale");
  expect(q.view("codex", 999).state).toBe("stale");
  expect(new CandidateQuotas().view("codex", 1001).state).toBe("unknown");
  q.clear("codex");
  expect(q.view("codex", 1001).state).toBe("unknown");
  q.limited("codex", 1000, true, 600);
  expect(q.view("codex", 1001).state).toBe("simulated");
});
