import { expect, it } from "vitest";
import { LlmBudget, reserveLlmCall, withLlmBudget } from "./llm-budget.js";
import { unlimitedCalls } from "../../shared/llm-calls.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { runTurn } from "./loop.js";

function setup(limit = 0) {
  const abort = new AbortController();
  const budget = new LlmBudget(
    {
      ...unlimitedCalls,
      llmCallsPerTurn: limit,
      turn: 0,
      session: 0,
      simulatedTurn: 0,
      simulatedSession: 0,
      since: 0,
    },
    abort,
  );
  return { abort, budget };
}
it("allows the last permitted request and blocks only the next, aborting the parent", () => {
  const { budget, abort } = setup(2);
  withLlmBudget(budget, () => {
    reserveLlmCall(abort.signal);
    reserveLlmCall(abort.signal);
    expect(abort.signal.aborted).toBe(false);
    expect(() => reserveLlmCall(abort.signal)).toThrow("budget_exceeded");
  });
  expect(budget.calls.session).toBe(2);
  expect(abort.signal.aborted).toBe(true);
});
it("shares a cap across concurrent children and does not count blocked requests", async () => {
  const { budget, abort } = setup(2);
  const results = await withLlmBudget(budget, () =>
    Promise.allSettled(
      Array.from({ length: 4 }, async () => {
        await Promise.resolve();
        reserveLlmCall(abort.signal, true);
      }),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  expect(budget.calls).toMatchObject({
    turn: 2,
    session: 2,
    simulatedSession: 2,
  });
});
it("defaults to unlimited, separates scopes, and rejects cancelled or late dispatch", async () => {
  const first = setup();
  const second = setup(1);
  await Promise.all(
    [first, second].map(({ budget, abort }) =>
      withLlmBudget(budget, async () => {
        await Promise.resolve();
        reserveLlmCall(abort.signal);
      }),
    ),
  );
  withLlmBudget(first.budget, () => {
    for (let i = 0; i < 110; i++) reserveLlmCall(first.abort.signal);
    expect(() => reserveLlmCall(AbortSignal.abort())).toThrow();
    first.budget.close();
    expect(() => reserveLlmCall(first.abort.signal)).toThrow("aborted");
  });
  expect(first.budget.calls.turn).toBe(111);
  expect(second.budget.calls.turn).toBe(1);
});
it.each([1, 2])(
  "counts a rate-limit retry and reports budget_exceeded at cap %s",
  async (limit) => {
    const { budget, abort } = setup(limit);
    const provider = new FakeProvider({
      script: [
        { type: "rate_limited", retryAfterSec: 0 },
        { type: "fixture", name: "phase1-haiku-text" },
      ],
    });
    const result = await withLlmBudget(budget, () =>
      runTurn(
        {
          provider,
          model: "claude-haiku-4-5",
          system: "test",
          messages: [],
          tools: new Map(),
          permission: async () => true,
          sleep: async () => {},
        },
        abort.signal,
      ),
    );
    expect(result.stopCause).toBe(limit === 1 ? "budget_exceeded" : "end_turn");
    expect(budget.calls.turn).toBe(limit);
  },
);
