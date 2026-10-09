import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionController } from "./controller.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { type UiEvent } from "../../shared/ipc.js";
import type { OfficialSessionSubmission } from "../../shared/official-session.js";
import { WorkspaceTrust } from "../config/trust.js";
import { SessionStore } from "./store.js";

const controllers: SessionController[] = [];
afterEach(async () => {
  await Promise.all(
    controllers.splice(0).map((controller) => controller.shutdown()),
  );
});
async function setup(official = true) {
  const home = await mkdtemp(join(tmpdir(), "xh-slash-controller-"));
  const cwd = await mkdtemp(join(tmpdir(), "xh-slash-workspace-"));
  const events: UiEvent[] = [];
  const provider = new FakeProvider();
  const legacy = vi.spyOn(provider, "stream").mockImplementation(() => {
    throw new Error("Legacy execution must not run");
  });
  const bridge = vi.fn(async (request: OfficialSessionSubmission) => ({
    workflowId: `slash-official-${request.sessionId}`,
    status: "completed",
    intent: "question" as const,
    summary: "公式fixture回答",
    taskRequired: false,
  }));
  const controller = new SessionController({
    home,
    fake: true,
    model: "claude:opus",
    version: "test",
    provider,
    ...(official ? { officialSession: bridge } : {}),
    host: { pickFolder: async () => cwd },
    emit: (e) => events.push(e),
  });
  controllers.push(controller);
  await controller.init();
  const picked = await controller.handle({ type: "pick_folder" });
  if (!picked.ok || !picked.workspaceId)
    throw new Error("Fixture folder unavailable");
  const created = await controller.handle({
    type: "new_session",
    workspaceId: picked.workspaceId,
  });
  if (!created.ok || !created.sessionId)
    throw new Error("Fixture session unavailable");
  const id = created.sessionId;
  const send = (text: string) =>
    controller.handle({ type: "send", sessionId: id, text });
  return { home, cwd, controller, events, send, id, bridge, legacy };
}

// 旧built-inの実行やtrusted command展開は撤去した製品契約。
// 現行GUI/controllerでは /stop だけを制御として保持し、旧定義を実行しない。
it.each([true, false])(
  "rejects legacy slash input without official or legacy calls (official=%s)",
  async (official) => {
    const s = await setup(official);
    const before = (await s.controller.state()).sessions;
    for (const command of [
      "/init",
      "/cost",
      "/model",
      "/model codex:sol",
      "/mode plan",
      "/resume",
      `/resume ${s.id}`,
      "/clear",
      "/compact",
      "/review",
      "/phase plan",
      "/mcp",
      "/mcp reconnect saved",
      "/mcp__saved__task",
      "/task example",
    ]) {
      const result = await s.send(command);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok)
        expect(result.error).toMatch(/未対応|旧slash|旧HTTP|旧経路/);
    }
    expect((await s.controller.state()).sessions).toEqual(before);
    expect(s.bridge).not.toHaveBeenCalled();
    expect(s.legacy).not.toHaveBeenCalled();
    const store = new SessionStore(s.home);
    await store.load();
    expect(await store.messages(s.id)).toEqual([]);
  },
);

it("keeps trusted user/project command files and saved history unchanged on rejected expansion", async () => {
  const s = await setup();
  const projectFile = join(s.cwd, ".xharness", "commands", "task.md");
  const userFile = join(s.home, "commands", "task.md");
  await mkdir(join(s.cwd, ".xharness", "commands"), { recursive: true });
  await mkdir(join(s.home, "commands"), { recursive: true });
  await writeFile(projectFile, "/clear\n作業: $ARGUMENTS");
  await writeFile(userFile, "ユーザー定義: $ARGUMENTS");
  await new WorkspaceTrust(s.home).trust(s.cwd);
  expect(await s.send("履歴に残す質問")).toMatchObject({ ok: true });
  await vi.waitFor(() =>
    expect(s.events.some((e) => e.type === "turn" && e.status === "idle")).toBe(
      true,
    ),
  );
  const store = new SessionStore(s.home);
  await store.load();
  const before = await store.messages(s.id);
  const state = await s.controller.state();
  expect(await s.send("/task example")).toMatchObject({ ok: false });
  expect(await readFile(projectFile, "utf8")).toBe("/clear\n作業: $ARGUMENTS");
  expect(await readFile(userFile, "utf8")).toBe("ユーザー定義: $ARGUMENTS");
  expect(await store.messages(s.id)).toEqual(before);
  expect((await s.controller.state()).sessions).toEqual(state.sessions);
  expect(s.bridge).toHaveBeenCalledTimes(1);
  expect(s.bridge.mock.calls[0]![0].text).toBe("履歴に残す質問");
  expect(s.legacy).not.toHaveBeenCalled();
});

it("sends ordinary text only through the official bridge and preserves IPC history viewing and stop", async () => {
  const s = await setup();
  expect(await s.send("普通の質問")).toMatchObject({ ok: true });
  await vi.waitFor(() =>
    expect(s.events.some((e) => e.type === "turn" && e.status === "idle")).toBe(
      true,
    ),
  );
  expect(s.bridge).toHaveBeenCalledTimes(1);
  expect(s.bridge.mock.calls[0]![0]).toMatchObject({
    sessionId: s.id,
    text: "普通の質問",
    cwd: s.cwd,
  });
  expect(s.legacy).not.toHaveBeenCalled();
  const store = new SessionStore(s.home);
  await store.load();
  const saved = await store.messages(s.id);
  expect(saved[0]?.content).toContainEqual({
    type: "text",
    text: "普通の質問",
  });
  expect(
    saved.some((message) =>
      message.content.some(
        (block) => block.type === "text" && block.text === "公式fixture回答",
      ),
    ),
  ).toBe(true);
  expect(
    await s.controller.handle({ type: "close_session", sessionId: s.id }),
  ).toMatchObject({ ok: true });
  expect(
    await s.controller.handle({ type: "open_session", sessionId: s.id }),
  ).toMatchObject({ ok: true });
  expect(
    s.events.some(
      (e) =>
        e.type === "transcript" &&
        e.sessionId === s.id &&
        e.items.some(
          (item) =>
            item.kind === "assistant" && item.text === "公式fixture回答",
        ),
    ),
  ).toBe(true);
  expect(await s.send("/stop")).toMatchObject({ ok: true });
  expect(s.bridge).toHaveBeenCalledTimes(1);
  expect(s.legacy).not.toHaveBeenCalled();
  expect(await store.messages(s.id)).toEqual(saved);
});
