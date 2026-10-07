import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionController } from "./controller.js";
import { SessionStore } from "./store.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { parseCommand, type UiEvent } from "../../shared/ipc.js";
import type { OfficialSessionSubmission } from "../../shared/official-session.js";

const controllers: SessionController[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.shutdown();
});
async function setup(
  run: (
    r: OfficialSessionSubmission,
    s: AbortSignal,
  ) => Promise<{ summary: string; workflowId: string; status: string }>,
  config?: string,
) {
  const home = await mkdtemp(join(tmpdir(), "xh-official-session-")),
    events: UiEvent[] = [];
  if (config) await writeFile(join(home, "config.yaml"), config);
  const legacy = new FakeProvider(),
    oldStream = vi.spyOn(legacy, "stream");
  const official = vi.fn(run);
  const c = new SessionController({
    home,
    model: "claude:opus",
    fake: true,
    version: "test",
    provider: legacy,
    officialSession: official,
    host: { pickFolder: async () => undefined },
    emit: (e) => events.push(e),
  });
  controllers.push(c);
  await c.init();
  const created = await c.handle({ type: "new_session", workspaceId: null });
  if (!created.ok || !created.sessionId) throw new Error("missing session");
  return { c, home, events, official, oldStream, id: created.sessionId };
}
async function idle(c: SessionController, id: string) {
  for (let n = 0; n < 300; n++) {
    if ((await c.state()).sessions.find((s) => s.id === id)?.status === "idle")
      return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("question did not finish");
}
const result = {
  summary: "公式の回答",
  workflowId: "offline-workflow",
  status: "completed",
};
it("ordinary questions finish once, retain only this session's history and never use HTTP", async () => {
  const { c, id, home, official, oldStream, events } = await setup(
    async () => result,
  );
  expect((await c.state()).officialDefault).toBe(true);
  expect(
    await c.handle({ type: "send", sessionId: id, text: "最初の質問" }),
  ).toMatchObject({ ok: true });
  await idle(c, id);
  expect(official).toHaveBeenCalledTimes(1);
  expect(official.mock.calls[0]![0]).toMatchObject({
    sessionId: id,
    model: "claude:claude-opus-5-5",
    text: "最初の質問",
    history: [],
  });
  expect(official.mock.calls[0]![0].task).toBeUndefined();
  expect(
    events.some(
      (e) =>
        e.type === "turn" && e.status === "idle" && e.stopCause === "end_turn",
    ),
  ).toBe(true);
  await c.handle({ type: "send", sessionId: id, text: "続きの質問" });
  await idle(c, id);
  expect(official).toHaveBeenCalledTimes(2);
  expect(official.mock.calls[1]![0].history).toEqual([
    { role: "user", text: "最初の質問" },
    { role: "assistant", text: result.summary },
  ]);
  expect(oldStream).not.toHaveBeenCalled();
  expect(
    await readFile(join(home, "sessions", `${id}.jsonl`), "utf8"),
  ).toContain(result.summary);
  expect(
    await readFile(join(home, "receipts", `${id}.jsonl`), "utf8"),
  ).toContain("offline-workflow");
});
it("missing official connection fails visibly without HTTP fallback or rewriting saved choices", async () => {
  const { c, id, home, official, oldStream, events } = await setup(async () => {
    throw new Error("公式接続が利用できません。旧HTTPへ切り替えません。");
  });
  const store = new SessionStore(home);
  await store.load();
  const original = store.get(id)!;
  await c.handle({ type: "send", sessionId: id, text: "質問" });
  await idle(c, id);
  expect(official).toHaveBeenCalledTimes(1);
  expect(oldStream).not.toHaveBeenCalled();
  expect(
    events.some(
      (e) => e.type === "error" && e.message.includes("旧HTTPへ切り替えません"),
    ),
  ).toBe(true);
  await store.load();
  expect(store.get(id)).toMatchObject({
    model: original.model,
    effort: original.effort,
  });
  expect(store.get(id)?.connection).toBe(original.connection);
});
it("preserves unsupported protective settings and stops before any native dispatch", async () => {
  const config = "limits: {llmCallsPerSession: 1}\n";
  const { c, id, home, official, oldStream, events } = await setup(
    async () => result,
    config,
  );
  await c.handle({ type: "send", sessionId: id, text: "質問" });
  await idle(c, id);
  expect(official).not.toHaveBeenCalled();
  expect(oldStream).not.toHaveBeenCalled();
  expect(
    events.some(
      (e) => e.type === "error" && e.message.includes("設定を無視せず停止"),
    ),
  ).toBe(true);
  expect(await readFile(join(home, "config.yaml"), "utf8")).toBe(config);
  expect(
    await readFile(join(home, "sessions", `${id}.jsonl`), "utf8"),
  ).toContain("質問");
});

it.each([true, false])(
  "preserves an unsettled or unfinished legacy task and refuses to replay it through native agents (%s)",
  async (settled) => {
    const { c, id, home, official, oldStream } = await setup(
        async () => result,
      ),
      store = new SessionStore(home);
    await store.load();
    await store.recordEvaluationTask(id, "old-evaluation-task", true, settled);
    const before = await readFile(
      join(home, "sessions", `${id}.evaluation.jsonl`),
      "utf8",
    );
    const response = await c.handle({
      type: "send",
      sessionId: id,
      text: "続行",
    });
    expect(response.ok).toBe(false);
    expect(official).not.toHaveBeenCalled();
    expect(oldStream).not.toHaveBeenCalled();
    expect(
      await readFile(join(home, "sessions", `${id}.evaluation.jsonl`), "utf8"),
    ).toBe(before);
  },
);
it("rejects a scratch work request instead of quietly treating it as a question", async () => {
  const { c, id, official, oldStream } = await setup(async () => result);
  expect(
    await c.handle({
      type: "send",
      sessionId: id,
      text: "修正して",
      officialTask: { files: ["add.mjs"], testFile: "test.mjs" },
    }),
  ).toMatchObject({ ok: false });
  expect(official).not.toHaveBeenCalled();
  expect(oldStream).not.toHaveBeenCalled();
});
it("cancels an ordinary native question without starting another phase", async () => {
  const { c, id, official, oldStream, events } = await setup(
    async (_r, signal) =>
      new Promise((resolve) =>
        signal.addEventListener(
          "abort",
          () => resolve({ ...result, status: "cancelled" }),
          { once: true },
        ),
      ),
  );
  await c.handle({ type: "send", sessionId: id, text: "質問" });
  await vi.waitFor(() => expect(official).toHaveBeenCalledTimes(1));
  await c.handle({ type: "abort", sessionId: id });
  await idle(c, id);
  expect(
    events.some(
      (e) =>
        e.type === "turn" && e.status === "idle" && e.stopCause === "aborted",
    ),
  ).toBe(true);
  expect(official).toHaveBeenCalledTimes(1);
  expect(oldStream).not.toHaveBeenCalled();
});
it("IPC keeps explicit work intent and rejects malformed scope instead of a question fallback", () => {
  const command = {
    type: "send",
    sessionId: "session",
    text: "work",
    officialTask: { files: ["add.mjs"], testFile: "test.mjs" },
  };
  expect(parseCommand(command)).toMatchObject(command);
  for (const scope of [
    null,
    {},
    { files: [], testFile: "test.mjs" },
    { files: [1], testFile: "test.mjs" },
    { files: ["add.mjs"], testFile: "test.mjs", command: "npm install" },
  ])
    expect(parseCommand({ ...command, officialTask: scope })).toBeUndefined();
});
