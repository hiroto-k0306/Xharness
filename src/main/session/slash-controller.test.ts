import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionController } from "./controller.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { type UiEvent } from "../../shared/ipc.js";
import { WorkspaceTrust } from "../config/trust.js";
import { SessionStore } from "./store.js";

async function setup(phase4 = false) {
  const home = await mkdtemp(join(tmpdir(), "xh-slash-controller-"));
  const cwd = await mkdtemp(join(tmpdir(), "xh-slash-workspace-"));
  const events: UiEvent[] = [];
  const controller = new SessionController({
    home,
    fake: true,
    phase4,
    model: "fake",
    version: "test",
    provider: new FakeProvider(),
    host: { pickFolder: async () => cwd },
    emit: (e) => events.push(e),
  });
  await controller.init();
  const picked = await controller.handle({ type: "pick_folder" });
  if (!picked.ok || !picked.workspaceId) throw new Error();
  const created = await controller.handle({
    type: "new_session",
    workspaceId: picked.workspaceId,
  });
  if (!created.ok || !created.sessionId) throw new Error();
  const send = (text: string) =>
    controller.handle({ type: "send", sessionId: created.sessionId!, text });
  return { home, cwd, controller, events, send, id: created.sessionId };
}
it("runs local built-ins without LLM calls, preserves old sessions on clear and resumes them", async () => {
  const s = await setup();
  expect(await s.send("/init")).toEqual({ ok: true });
  expect(await readFile(join(s.cwd, "AGENTS.md"), "utf8")).toContain(
    "秘密情報",
  );
  expect(await s.send("/init")).toMatchObject({ ok: false });
  for (const text of ["/cost", "/model", "/resume"])
    expect(await s.send(text)).toEqual({ ok: true });
  expect(s.events.some((e) => e.type === "turn")).toBe(false);
  const clear = await s.send("/clear");
  expect(clear).toMatchObject({ ok: true });
  expect((await s.controller.state()).sessions).toHaveLength(2);
  expect((await s.controller.state()).currentSessionId).not.toBe(s.id);
  expect(
    await s.controller.handle({
      type: "send",
      sessionId: (await s.controller.state()).currentSessionId!,
      text: `/resume ${s.id}`,
    }),
  ).toMatchObject({ ok: true, sessionId: s.id });
  expect(await s.send("/mode plan")).toEqual({ ok: true });
  expect(await s.send("/init")).toMatchObject({
    ok: false,
    error: expect.stringContaining("plan"),
  });
});
it("lists only trusted definitions and sends the expansion as one ordinary user message", async () => {
  const s = await setup();
  await mkdir(join(s.cwd, ".xharness", "commands"), { recursive: true });
  await writeFile(
    join(s.cwd, ".xharness", "commands", "task.md"),
    "/clear\n作業: $ARGUMENTS",
  );
  expect((await s.controller.state()).commands).toEqual([]);
  expect(await s.send("/task example")).toMatchObject({ ok: false });
  await new WorkspaceTrust(s.home).trust(s.cwd);
  // Trust is normally recorded by this controller; reinitialize to model an app restart.
  const restarted = new SessionController({
    home: s.home,
    fake: true,
    model: "fake",
    version: "test",
    provider: new FakeProvider(),
    host: { pickFolder: async () => s.cwd },
    emit: (e) => s.events.push(e),
  });
  await restarted.init();
  await restarted.handle({ type: "open_session", sessionId: s.id });
  expect((await restarted.state()).commands?.[0]?.value).toBe("/task");
  expect(
    await restarted.handle({
      type: "send",
      sessionId: s.id,
      text: "/task example",
    }),
  ).toMatchObject({ ok: true });
  await restarted.shutdown();
  const store = new SessionStore(s.home);
  await store.load();
  expect((await store.messages(s.id))[0]?.content).toContainEqual({
    type: "text",
    text: "/clear\n作業: example",
  });
  expect((await restarted.state()).sessions).toHaveLength(1);
});
it("asks about project commands even when there are no permission-expanding project settings", async () => {
  const s = await setup(true);
  await mkdir(join(s.cwd, ".xharness", "commands"), { recursive: true });
  await writeFile(
    join(s.cwd, ".xharness", "commands", "check.md"),
    "確認 $ARGUMENTS",
  );
  await s.send("普通の依頼");
  await vi.waitFor(() =>
    expect(
      s.events.some(
        (e) => e.type === "permission_request" && e.tool === "ProjectSettings",
      ),
    ).toBe(true),
  );
  const request = s.events.find(
    (e) => e.type === "permission_request",
  ) as Extract<UiEvent, { type: "permission_request" }>;
  await s.controller.handle({
    type: "permission_response",
    sessionId: s.id,
    requestId: request.requestId,
    decision: "session",
  });
  await vi.waitFor(async () =>
    expect((await s.controller.state()).commands?.[0]?.value).toBe("/check"),
  );
  await s.controller.shutdown();
  expect(await new WorkspaceTrust(s.home).isTrusted(s.cwd)).toBe(false);
});
