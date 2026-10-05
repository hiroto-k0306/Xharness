import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStore, RECOVERY_NOTICE } from "./store.js";
import { ReceiptStore } from "./receipts.js";
import { SessionController } from "./controller.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { type UiEvent } from "../../shared/ipc.js";
import { readExecutionReport, renderExecutionReport } from "./report.js";
import { evaluateTrace } from "./evaluation.js";
import { ClaudeAdapter } from "../providers/claude/adapter.js";
import { CodexAdapter } from "../providers/codex/adapter.js";
import { withSessionCalls } from "./llm-calls.js";
import { unlimitedCalls } from "../../shared/llm-calls.js";
import {
  traceOperation,
  withSessionTrace,
  withTaskTrace,
} from "../core/trace.js";

afterEach(() => vi.restoreAllMocks());
const temp = () => mkdtemp(join(tmpdir(), "xh-consistency-"));
it.each(["claude", "codex"])(
  "does not dispatch %s when a reserved call cannot be persisted",
  async (kind) => {
    const home = await temp(),
      abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>();
    const provider =
      kind === "claude"
        ? new ClaudeAdapter({ getAccessToken: async () => "dummy", fetcher })
        : new CodexAdapter({
            getCredentials: async () => ({
              accessToken: "dummy",
              accountId: "dummy",
            }),
            fetcher,
          });
    await expect(
      withSessionCalls(
        { home, id: "s", abort, limits: unlimitedCalls },
        async () => {
          const target = join(home, "sessions", "s.llm-calls.json");
          await rm(target);
          await mkdir(target);
          for await (const event of provider.stream(
            {
              model: kind === "claude" ? "claude-haiku-4-5" : "gpt-6-luna",
              system: "offline",
              messages: [
                { role: "user", content: [{ type: "text", text: "ping" }] },
              ],
              tools: [],
            },
            abort.signal,
          ))
            void event;
        },
      ),
    ).rejects.toThrow("budget_storage_failed");
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each(["receipt", "history", "commit", "torn-commit"])(
  "fences a %s write failure after a fake completion, recovers logs without replay",
  async (cut) => {
    const home = await temp();
    const events: UiEvent[] = [];
    let requests = 0;
    const make = () =>
      new SessionController({
        home,
        provider: new FakeProvider({ onRequest: () => requests++ }),
        model: "fake",
        fake: true,
        version: "test",
        emit: (event) => events.push(event),
        host: { pickFolder: async () => undefined },
        createTools: () => new Map(),
      });
    const controller = make();
    await controller.init();
    const created = await controller.handle({
      type: "new_session",
      workspaceId: null,
    });
    if (!created.ok || !created.sessionId) throw new Error("session missing");
    const sessionId = created.sessionId;
    if (cut === "receipt")
      vi.spyOn(ReceiptStore.prototype, "append").mockRejectedValue(
        new Error("injected disk fault"),
      );
    if (cut === "history") {
      const append = SessionStore.prototype.append;
      vi.spyOn(SessionStore.prototype, "append").mockImplementation(function (
        this: SessionStore,
        id,
        messages,
        clean,
      ) {
        if (messages.some((m) => m.role === "assistant"))
          return Promise.reject(new Error("injected history fault"));
        return append.call(this, id, messages, clean);
      });
    }
    if (cut === "commit" || cut === "torn-commit") {
      const record = SessionStore.prototype.recordEvaluationTask;
      vi.spyOn(
        SessionStore.prototype,
        "recordEvaluationTask",
      ).mockImplementation(async function (
        this: SessionStore,
        id,
        task,
        active,
        settled,
      ) {
        if (settled) {
          if (cut === "torn-commit")
            await appendFile(
              join(home, "sessions", id + ".evaluation.jsonl"),
              '{"evaluationTask":{"id":',
            );
          throw new Error("injected commit fault");
        }
        return record.call(this, id, task, active, settled);
      });
    }
    await controller.handle({ type: "send", sessionId, text: "ping" });
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "turn" && e.status === "idle")).toBe(
        true,
      ),
    );
    expect(requests).toBe(1);
    const original = await new SessionStore(home).evaluationTask(sessionId);
    expect(original).toMatchObject({
      active: true,
      settled: false,
      recoveryRequired: true,
    });
    expect((await new SessionStore(home).messages(sessionId))[0]?.role).toBe(
      "user",
    );
    await controller.shutdown();
    vi.restoreAllMocks();
    const restarted = make();
    await restarted.init();
    const recovered = await new SessionStore(home).evaluationTask(sessionId);
    expect(recovered).toMatchObject({
      id: original!.id,
      active: false,
      settled: false,
      recoveryRequired: true,
    });
    expect(
      await restarted.handle({ type: "send", sessionId, text: "resume" }),
    ).toEqual({ ok: false, error: RECOVERY_NOTICE });
    expect(
      await restarted.handle({ type: "send", sessionId, text: "/compact" }),
    ).toEqual({ ok: false, error: RECOVERY_NOTICE });
    expect(requests).toBe(1);
    const report = await readExecutionReport(home, sessionId);
    const task = evaluateTrace(report[0]?.trace)[0]!;
    expect(task.calls).toHaveLength(1);
    expect(task.metrics.input.known).toBeGreaterThan(0);
    expect(renderExecutionReport(report)).toContain("保存未確定");
    const next = await restarted.handle({
      type: "new_session",
      workspaceId: null,
    });
    expect(next.ok).toBe(true);
    await restarted.shutdown();
  },
);
it("never replays an ambiguous external tool outcome from recovered logs", async () => {
  const home = await temp(),
    store = new SessionStore(home);
  await store.save({
    id: "s",
    title: "interrupted",
    cwd: home,
    workspaceId: null,
    readOnly: false,
    model: "fake",
    effort: "high",
    providers: [],
    createdAt: 0,
    updatedAt: 0,
  });
  await store.recordEvaluationTask("s", "task", true, false);
  let effects = 0;
  await expect(
    withSessionTrace(
      home,
      "s",
      (s) => s,
      () =>
        withTaskTrace({ model: "fake", taskId: "task" }, async () => {
          await traceOperation("tool", "Write", {}, async () => {
            effects++;
            throw new Error("terminated after mock side effect");
          });
          return { stopCause: "end_turn" };
        }),
    ),
  ).rejects.toThrow();
  const requests = vi.fn();
  const controller = new SessionController({
    home,
    provider: new FakeProvider({ onRequest: requests }),
    model: "fake",
    fake: true,
    version: "test",
    emit: () => {},
    host: { pickFolder: async () => undefined },
    createTools: () => new Map(),
  });
  await controller.init();
  expect(
    await controller.handle({ type: "send", sessionId: "s", text: "resume" }),
  ).toEqual({ ok: false, error: RECOVERY_NOTICE });
  expect(effects).toBe(1);
  expect(requests).not.toHaveBeenCalled();
  expect(renderExecutionReport(await readExecutionReport(home, "s"))).toContain(
    "保存未確定",
  );
  await controller.shutdown();
});
it("retains torn history/receipt evidence and appends new records on a separate line", async () => {
  const home = await temp(),
    store = new SessionStore(home),
    receipts = new ReceiptStore(home);
  await store.append(
    "s",
    [{ role: "user", content: [{ type: "text", text: "old" }] }],
    (s) => s,
  );
  const path = join(home, "sessions", "s.jsonl");
  await writeFile(
    path,
    (await readFile(path, "utf8")) + '{"role":"assistant","content":',
  );
  await store.append(
    "s",
    [{ role: "user", content: [{ type: "text", text: "new" }] }],
    (s) => s,
  );
  expect(await store.messages("s")).toHaveLength(2);
  const receipt = {
    id: "#1",
    sessionId: "s",
    ts: 1,
    provider: "harness" as const,
    kind: "tool" as const,
    durationMs: 1,
    summary: "known",
  };
  await receipts.append("s", [receipt], (s) => s);
  const receiptPath = join(home, "receipts", "s.jsonl");
  await writeFile(
    receiptPath,
    (await readFile(receiptPath, "utf8")) + '{"id":',
  );
  await receipts.append("s", [receipt, { ...receipt, id: "#2" }], (s) => s);
  expect((await receipts.read("s")).map((r) => r.id)).toEqual(["#1", "#2"]);
  expect(await readFile(path, "utf8")).toContain(
    '{"role":"assistant","content":\n',
  );
});
