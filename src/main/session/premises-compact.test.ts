// A local Provider mock exercises Claude's path without any HTTP/SDK/auth calls.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type UiEvent } from "../../shared/ipc.js";
import { type Provider, type ProviderRequest } from "../providers/provider.js";
import { reserveLlmCall } from "../core/llm-budget.js";
import { traceStream } from "../core/trace.js";
import { SessionController } from "./controller.js";
import { SessionStore } from "./store.js";
import { PREMISE_NOTICE } from "./premises.js";
import { FILE_LINK_GUIDANCE } from "../core/output-guidance.js";
import { systemPrompt } from "./turn.js";
import { type ControllerContext } from "./context.js";
import { type Message } from "../core/types.js";
import { evaluateTrace, evaluateSessionCommon } from "./evaluation.js";
import { readTraceReplay } from "./report-trace.js";

beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Offline only");
    }),
  ),
);
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "xh-premise-compact-"));
  const requests: ProviderRequest[] = [],
    events: UiEvent[] = [];
  const provider: Provider = {
    id: "claude",
    models: () => [{ id: "claude-opus-5-5", contextTokens: 200000 }],
    async *stream(request, signal) {
      reserveLlmCall(signal, true);
      requests.push(request);
      yield {
        type: "message_done",
        stopReason: request.compaction ? "compaction" : "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
        message: {
          role: "assistant",
          content: request.compaction
            ? [
                {
                  type: "compaction",
                  provider: "claude",
                  payload: {
                    type: "compaction",
                    content: "DUMMY-OFFLINE-SUMMARY",
                  },
                },
              ]
            : [{ type: "text", text: "offline answer" }],
        },
      };
    },
  };
  const mockStream = provider.stream.bind(provider);
  provider.stream = (request, signal) =>
    traceStream(
      "claude",
      { internal: request },
      mockStream(request, signal),
      true,
    );
  const make = () =>
    new SessionController({
      home,
      provider,
      model: "claude-opus-5-5",
      fake: true,
      phase4: true,
      version: "test",
      host: { pickFolder: async () => undefined },
      createTools: () => new Map(),
      emit: (e) => events.push(e),
    });
  const controller = make();
  await controller.init();
  const created = await controller.handle({
    type: "new_session",
    workspaceId: null,
  });
  if (!created.ok || !created.sessionId) throw new Error("fixture failed");
  const id = created.sessionId;
  const send = async (c: SessionController, text: string) => {
    events.length = 0;
    expect(await c.handle({ type: "send", sessionId: id, text })).toMatchObject(
      { ok: true },
    );
    await vi.waitFor(
      () =>
        expect(
          events.some((e) => e.type === "turn" && e.status === "idle"),
        ).toBe(true),
      { timeout: 10000 },
    );
  };
  return { home, id, controller, make, send, requests };
}
it("manual Claude compact uses the validated workflow prefix and leaves original history intact", async () => {
  const c = await fixture();
  await c.send(c.controller, "first");
  await c.send(c.controller, "second");
  const path = join(c.home, "sessions", `${c.id}.jsonl`);
  const history = await readFile(path, "utf8");
  expect(
    await c.controller.handle({
      type: "send",
      sessionId: c.id,
      text: "/compact",
    }),
  ).toEqual({ ok: true });
  expect(c.requests).toHaveLength(3);
  expect(c.requests[2]!.compaction).toEqual({ type: "summarize" });
  expect(c.requests[2]!.system).toBe(c.requests[1]!.system);
  expect(c.requests[2]!.tools).toEqual(c.requests[1]!.tools);
  expect(c.requests[2]!.tools.some((t) => t.name === "Task")).toBe(true);
  expect(await readFile(path, "utf8")).toBe(history);
  const trace = await readTraceReplay(c.home, c.id, (s) => s);
  expect(evaluateTrace(trace).every((task) => task.calls.length === 1)).toBe(
    true,
  );
  expect(evaluateSessionCommon(trace)?.calls).toHaveLength(1);
  await c.controller.shutdown();
});
it("attributes manual compact to a persisted unfinished task after restart without completing it", async () => {
  const c = await fixture();
  // Persist an interrupted task and legacy history with no assistant-prefix requirements.
  const store = new SessionStore(c.home);
  await store.append(
    c.id,
    [
      { role: "user", content: [{ type: "text", text: "old" }] },
      { role: "user", content: [{ type: "text", text: "latest" }] },
    ],
    (s) => s,
  );
  await store.recordEvaluationTask(c.id, "interrupted-task", true);
  await c.controller.shutdown();
  const resumed = c.make();
  await resumed.init();
  expect(
    await resumed.handle({ type: "send", sessionId: c.id, text: "/compact" }),
  ).toEqual({ ok: true });
  const trace = await readTraceReplay(c.home, c.id, (s) => s);
  const calls = trace!.records.filter(
    (r) => r.kind === "llm" && r.phase === "start",
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]?.taskId).toBe("interrupted-task");
  expect(await store.evaluationTask(c.id)).toEqual({
    id: "interrupted-task",
    active: true,
  });
  expect(evaluateSessionCommon(trace)).toBeUndefined();
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  await resumed.shutdown();
});
it.each([false, true])(
  "reconstructs the manual compact system before any normal turn (pre-guidance=%s)",
  async (legacy) => {
    const c = await fixture();
    let resumed: SessionController | undefined;
    try {
      await c.controller.shutdown();
      const store = new SessionStore(c.home);
      await store.load();
      const session = { ...store.get(c.id)! };
      expect(session.fileLinkGuidanceVersion).toBe(1);
      expect(session.premiseHash).toBeUndefined();
      if (legacy) {
        delete session.fileLinkGuidanceVersion;
        await store.save(session);
      }
      // assistant が無いので前提検証guardを通過し、最初のuserを圧縮できる。
      const messages: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: "first pending user" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "latest pending user" }],
        },
      ];
      await store.append(c.id, messages, (s) => s);
      const path = join(c.home, "sessions", `${c.id}.jsonl`);
      const indexPath = join(c.home, "sessions", "index.json");
      const history = await readFile(path, "utf8");
      const index = await readFile(indexPath, "utf8");
      resumed = c.make();
      await resumed.init();
      // 通常ターンを送らない: rt.premises / rt.system の両方が未設定の経路。
      expect(c.requests).toHaveLength(0);
      expect(
        await resumed.handle({
          type: "send",
          sessionId: c.id,
          text: "/compact",
        }),
      ).toEqual({ ok: true });
      expect(c.requests).toHaveLength(1);
      const request = c.requests[0]!;
      const ctx = {
        options: { home: c.home },
        clean: (s: string) => s,
      } as ControllerContext;
      expect(request.system).toBe(
        await systemPrompt(ctx, session.cwd, true, undefined, !legacy),
      );
      if (legacy) expect(request.system).not.toContain(FILE_LINK_GUIDANCE);
      else expect(request.system).toContain(FILE_LINK_GUIDANCE);
      expect(request.compaction).toEqual({ type: "summarize" });
      expect(request.tools).toEqual([]);
      expect(request.messages).toEqual([messages[0]]);
      expect(await readFile(path, "utf8")).toBe(history);
      expect(await readFile(indexPath, "utf8")).toBe(index);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    } finally {
      await resumed?.shutdown();
      await c.controller.shutdown();
      await rm(c.home, { recursive: true, force: true });
    }
  },
);
it.each([false, true])(
  "does not compact an unvalidated restored Claude history (legacy=%s)",
  async (legacy) => {
    const c = await fixture();
    await c.send(c.controller, "first");
    await c.controller.shutdown();
    if (legacy) {
      const store = new SessionStore(c.home);
      await store.load();
      const session = store.get(c.id)!;
      await store.save({ ...session, premiseHash: undefined });
    }
    const path = join(c.home, "sessions", `${c.id}.jsonl`),
      history = await readFile(path, "utf8");
    const resumed = c.make();
    await resumed.init();
    expect(
      await resumed.handle({ type: "send", sessionId: c.id, text: "/compact" }),
    ).toEqual({ ok: false, error: PREMISE_NOTICE });
    expect(c.requests).toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe(history);
    await resumed.shutdown();
  },
);
