import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readLlmCalls, withSessionCalls } from "./llm-calls.js";
import { reserveLlmCall } from "../core/llm-budget.js";
import { unlimitedCalls } from "../../shared/llm-calls.js";
import { SessionStore } from "./store.js";

it("persists the session cap across turns/restarts, while resetting the turn cap", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-calls-"));
  const options = {
    home,
    id: "test",
    limits: { llmCallsPerTurn: 2, llmCallsPerSession: 3 },
  };
  for (const expected of [2, 3]) {
    const abort = new AbortController();
    await withSessionCalls({ ...options, abort }, async (budget) => {
      reserveLlmCall(abort.signal, true);
      if (expected === 2) reserveLlmCall(abort.signal);
      else
        expect(() => reserveLlmCall(abort.signal)).toThrow("budget_exceeded");
      expect(budget.calls.turn).toBe(expected === 2 ? 2 : 1);
    });
    expect((await readLlmCalls(home, "test")).session).toBe(expected);
  }
  const abort = new AbortController();
  await withSessionCalls({ ...options, abort }, async (budget) => {
    expect(() => reserveLlmCall(abort.signal)).toThrow("budget_exceeded");
    expect(budget.calls.turn).toBe(0);
  });
  expect((await readLlmCalls(home, "other")).session).toBe(0);
  await new SessionStore(home).delete("test");
  expect((await readLlmCalls(home, "test")).session).toBe(0);
});
it("fails closed on a corrupt counter instead of resetting a session cap", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-calls-corrupt-"));
  await mkdir(join(home, "sessions"));
  await writeFile(join(home, "sessions", "test.llm-calls.json"), "{broken");
  await expect(
    withSessionCalls(
      {
        home,
        id: "test",
        limits: unlimitedCalls,
        abort: new AbortController(),
      },
      async () => {
        throw new Error("must not run");
      },
    ),
  ).rejects.toThrow("budget_storage_failed");
});
it("aborts and reports a write failure without exposing filesystem error contents", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-calls-write-"));
  const abort = new AbortController();
  await expect(
    withSessionCalls(
      { home, id: "test", limits: unlimitedCalls, abort },
      async (budget) => {
        const target = join(home, "sessions", "test.llm-calls.json");
        await rm(target);
        await mkdir(target); // rename先がディレクトリのため、後続保存は失敗する。
        reserveLlmCall(abort.signal);
        await budget.flush();
        expect(abort.signal.aborted).toBe(true);
      },
    ),
  ).rejects.toThrow("budget_storage_failed");
});
