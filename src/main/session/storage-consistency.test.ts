import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStore, RECOVERY_NOTICE } from "./store.js";
import { ReceiptStore } from "./receipts.js";
import { SessionController } from "./controller.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { type UiEvent } from "../../shared/ipc.js";
import { readExecutionReport, renderExecutionReport } from "./report.js";
import {
  traceOperation,
  withSessionTrace,
  withTaskTrace,
} from "../core/trace.js";

afterEach(() => vi.restoreAllMocks());
const temp = () => mkdtemp(join(tmpdir(), "xh-consistency-"));
it.each(["receipt", "history"])(
  "reports a %s persistence failure after official completion without replaying on restart",
  async (cut) => {
    const home = await temp();
    const events: UiEvent[] = [];
    const official = vi.fn(async () => ({
      summary: "official answer",
      workflowId: "offline-workflow",
      status: "completed",
    }));
    const make = () =>
      new SessionController({
        home,
        provider: new FakeProvider(),
        model: "claude:opus",
        fake: true,
        version: "test",
        officialSession: official,
        emit: (event) => events.push(event),
        host: { pickFolder: async () => undefined },
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
    else {
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
    await controller.handle({ type: "send", sessionId, text: "ping" });
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "turn" && e.status === "idle")).toBe(
        true,
      ),
    );
    expect(official).toHaveBeenCalledTimes(1);
    expect(
      events.some(
        (e) => e.type === "error" && e.message === "履歴の保存に失敗しました",
      ),
    ).toBe(true);
    expect(
      (await new SessionStore(home).messages(sessionId)).map((m) => m.role),
    ).toEqual(["user"]);
    await controller.shutdown();
    vi.restoreAllMocks();
    const restarted = make();
    await restarted.init();
    await restarted.handle({ type: "open_session", sessionId });
    expect(official).toHaveBeenCalledTimes(1);
    expect(
      (await new SessionStore(home).messages(sessionId)).map((m) => m.role),
    ).toEqual(["user"]);
    await restarted.shutdown();
  },
);
it.each(["commit", "torn-commit"])(
  "retains an unsettled historical %s and refuses official replay after restart",
  async (cut) => {
    const home = await temp(),
      store = new SessionStore(home);
    await store.save({
      id: "s",
      title: "historical task",
      cwd: home,
      workspaceId: null,
      readOnly: false,
      model: "claude:opus",
      effort: "high",
      providers: [],
      createdAt: 0,
      updatedAt: 0,
    });
    await store.recordEvaluationTask("s", "historical-task", true, false);
    if (cut === "torn-commit")
      await appendFile(
        join(home, "sessions", "s.evaluation.jsonl"),
        '{"evaluationTask":{"id":',
      );
    const official = vi.fn(async () => ({
      summary: "unexpected",
      workflowId: "unexecuted",
      status: "completed",
    }));
    const controller = new SessionController({
      home,
      provider: new FakeProvider(),
      model: "claude:opus",
      fake: true,
      version: "test",
      officialSession: official,
      emit: () => {},
      host: { pickFolder: async () => undefined },
    });
    await controller.init();
    expect(await new SessionStore(home).evaluationTask("s")).toMatchObject({
      id: "historical-task",
      settled: false,
      recoveryRequired: true,
    });
    expect(
      await controller.handle({ type: "send", sessionId: "s", text: "resume" }),
    ).toEqual({ ok: false, error: RECOVERY_NOTICE });
    expect(official).not.toHaveBeenCalled();
    await controller.shutdown();
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
  const official = vi.fn(async () => ({
    workflowId: "unused",
    status: "completed" as const,
    summary: "unused",
  }));
  const tracePath = join(home, "traces", "s.jsonl");
  const traceBefore = await readFile(tracePath);
  const controller = new SessionController({
    home,
    provider: new FakeProvider({ onRequest: requests }),
    model: "claude:opus",
    officialSession: official,
    fake: true,
    version: "test",
    emit: () => {},
    host: { pickFolder: async () => undefined },
  });
  await controller.init();
  expect(
    await controller.handle({ type: "send", sessionId: "s", text: "resume" }),
  ).toEqual({ ok: false, error: RECOVERY_NOTICE });
  expect(effects).toBe(1);
  expect(requests).not.toHaveBeenCalled();
  expect(official).not.toHaveBeenCalled();
  expect(await readFile(tracePath)).toEqual(traceBefore);
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
