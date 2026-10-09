import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ClaudeAdapter } from "./claude/adapter.js";
import { CodexAdapter } from "./codex/adapter.js";
import { FakeProvider } from "./fake/fake-provider.js";
import { LlmBudget, withLlmBudget } from "../core/llm-budget.js";
import { unlimitedCalls } from "../../shared/llm-calls.js";
import { type ProviderRequest } from "./provider.js";
import { prepareProviderHistory } from "../context/provider-compactor.js";
import { ChildRunner } from "../agents/runner.js";
import { Router } from "../core/router.js";

async function gather(source: AsyncIterable<unknown>) {
  const events = [];
  for await (const e of source) events.push(e);
  return events;
}
function setup(limit = 1) {
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
  return { budget, abort };
}
const request: ProviderRequest = {
  model: "gpt-6-luna",
  system: "test",
  tools: [],
  messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
};
async function recorded(provider: string) {
  const name = provider === "claude" ? "phase1-haiku-text" : "x2-gpt-6-luna";
  const fixture = JSON.parse(
    await readFile(`test/fixtures/${provider}/${name}.json`, "utf8"),
  );
  return new Response(
    fixture.events
      .map(
        (e: { event: string; data: string }) =>
          `event: ${e.event}\ndata: ${e.data}\n\n`,
      )
      .join(""),
  );
}
it.each(["claude", "codex"])(
  "%s counts actual dispatch, transport errors and 429, but blocks the next fetch",
  async (id) => {
    for (const response of ["fixture", "transport", "429"]) {
      const { budget, abort } = setup();
      const fetcher = vi.fn(async () => {
        if (response === "transport")
          throw new Error("synthetic-sensitive-error");
        return response === "429"
          ? new Response(null, { status: 429 })
          : recorded(id);
      });
      const provider =
        id === "claude"
          ? new ClaudeAdapter({ fetcher, getAccessToken: async () => "test" })
          : new CodexAdapter({
              fetcher,
              getCredentials: async () => ({
                accessToken: "test",
                accountId: "test",
              }),
            });
      const req = {
        ...request,
        model: id === "claude" ? "claude-haiku-4-5" : request.model,
      };
      await withLlmBudget(budget, async () => {
        await gather(provider.stream(req, abort.signal));
        await gather(provider.stream(req, abort.signal));
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(budget.calls.turn).toBe(1);
      expect(budget.stopCause).toBe("budget_exceeded");
    }
  },
);
it.each(["claude", "codex"])(
  "%s does not count requests rejected before authentication/dispatch",
  async (id) => {
    const { budget, abort } = setup();
    const fetcher = vi.fn();
    const reject = async (): Promise<never> => {
      throw new Error("synthetic-credential-error");
    };
    const provider =
      id === "claude"
        ? new ClaudeAdapter({ fetcher, getAccessToken: reject })
        : new CodexAdapter({ fetcher, getCredentials: reject });
    await withLlmBudget(budget, () =>
      gather(
        provider.stream(
          {
            ...request,
            model: id === "claude" ? "claude-haiku-4-5" : request.model,
          },
          abort.signal,
        ),
      ),
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(budget.calls.turn).toBe(0);
  },
);
it("charges provider compaction against the same turn as the following response", async () => {
  const { budget, abort } = setup();
  const fetcher = vi.fn(() => recorded("codex"));
  const provider = new CodexAdapter({
    fetcher,
    getCredentials: async () => ({ accessToken: "test", accountId: "test" }),
  });
  await withLlmBudget(budget, async () => {
    const prepared = await prepareProviderHistory(
      Array.from({ length: 3 }, () => request.messages).flat(),
      {
        provider,
        model: request.model,
        system: "test",
        tools: [],
        threshold: 0.8,
        force: true,
        signal: abort.signal,
      },
    );
    expect(prepared.compacted).toBe(true);
    await gather(provider.stream(request, abort.signal));
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(budget.stopCause).toBe("budget_exceeded");
});
it("a real child runner inherits its parent budget without an independent allowance", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-child-budget-"));
  const { budget, abort } = setup();
  const dispatched = vi.fn();
  const provider = new FakeProvider({ onRequest: dispatched });
  const runner = new ChildRunner({
    home,
    parentId: "parent",
    router: new Router([provider]),
    createTools: () => new Map(),
    permission: async () => true,
  });
  await withLlmBudget(budget, async () => {
    await gather(
      provider.stream({ ...request, model: "claude-sonnet-5-5" }, abort.signal),
    );
    await expect(
      runner.run(
        "explorer",
        { model: "claude:sonnet", tools: [] },
        "inspect",
        home,
        abort.signal,
      ),
    ).rejects.toThrow("budget_exceeded");
  });
  expect(dispatched).toHaveBeenCalledTimes(1);
  expect(budget.stopCause).toBe("budget_exceeded");
  expect(abort.signal.aborted).toBe(true);
});
