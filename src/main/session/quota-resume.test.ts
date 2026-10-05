import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionController } from "./controller.js";
import { SessionStore, WorkspaceStore } from "./store.js";
import {
  FakeProvider,
  type FakeStep,
} from "../providers/fake/fake-provider.js";
import { type ProviderRequest } from "../providers/provider.js";
import { type UiEvent } from "../../shared/ipc.js";

const done: FakeStep = {
  type: "message",
  stopReason: "end_turn",
  message: { role: "assistant", content: [{ type: "text", text: "done" }] },
};
const quota: FakeStep = {
  type: "rate_limited",
  retryAfterSec: 120,
  scope: "5h",
};
const fixtures: { base: string; controllers: SessionController[] }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const c of f.controllers) await c.shutdown();
    await rm(f.base, { recursive: true, force: true });
  }
});
async function fixture(script: FakeStep[] = [quota, done], mode = "off") {
  const base = await mkdtemp(join(tmpdir(), "xh-quota-integration-")),
    home = join(base, "home"),
    root = join(base, "root");
  await mkdir(home);
  await mkdir(root);
  await writeFile(join(home, "config.yaml"), `workflow: {mode: ${mode}}\n`);
  await writeFile(join(root, "read.txt"), "data");
  const sessions = new SessionStore(home),
    workspaces = new WorkspaceStore(home);
  await sessions.load();
  await workspaces.load();
  const workspaceId = await workspaces.add(root);
  const requests: ProviderRequest[] = [],
    events: UiEvent[] = [],
    controllers: SessionController[] = [];
  fixtures.push({ base, controllers });
  let now = Date.now();
  const create = (script: FakeStep[]) => {
    const c = new SessionController({
      home,
      fake: true,
      version: "test",
      model: "fake",
      phase4: true,
      quotaNow: () => now,
      quotaTimers: false,
      emit: (e) => events.push(e),
      sleep: async () => {},
      host: { pickFolder: async () => root },
      provider: new FakeProvider({
        script,
        onRequest: (r) => requests.push(r),
      }),
    });
    controllers.push(c);
    return c;
  };
  const c = create(script);
  await c.init();
  const created = await c.handle({ type: "new_session", workspaceId });
  if (!created.ok || !created.sessionId) throw new Error("Missing session");
  const id = created.sessionId;
  await c.handle({ type: "send", sessionId: id, text: "Complete this task" });
  await vi.waitFor(async () =>
    expect((await c.state()).sessions.find((s) => s.id === id)?.status).toBe(
      "idle",
    ),
  );
  const pause = () =>
    c.state().then((s) => s.sessions.find((s) => s.id === id)?.quotaPause);
  return {
    c,
    create,
    id,
    pause,
    requests,
    events,
    sessions,
    home,
    root,
    advance: () => {
      now += 121000;
    },
  };
}
it("continues saved last request under the same task without replaying its user message", async () => {
  const f = await fixture();
  expect(await f.pause(), JSON.stringify(await f.pause())).toMatchObject({
    state: "paused",
    eligible: true,
    attempts: 0,
  });
  await f.sessions.load();
  const task = await f.sessions.evaluationTask(f.id);
  await f.c.tickQuotaResume();
  expect(f.requests).toHaveLength(1);
  expect(
    await f.c.handle({
      type: "quota_resume",
      sessionId: f.id,
      action: "enable",
    }),
  ).toMatchObject({ ok: true });
  f.advance();
  await f.c.tickQuotaResume();
  expect(await f.pause()).toMatchObject({ state: "completed", attempts: 1 });
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]!.messages).toEqual(f.requests[0]!.messages);
  expect(f.requests[1]!.system).toEqual(f.requests[0]!.system);
  expect(f.requests[1]!.tools).toEqual(f.requests[0]!.tools);
  expect(
    (await f.sessions.messages(f.id)).filter((m) => m.role === "user"),
  ).toHaveLength(1);
  expect((await f.sessions.evaluationTask(f.id))?.id).toBe(task?.id);
});
it("restores an enabled waiting checkpoint after app restart", async () => {
  const f = await fixture();
  await f.c.handle({ type: "quota_resume", sessionId: f.id, action: "enable" });
  await f.c.shutdown();
  const c = f.create([done]);
  await c.init();
  f.advance();
  await c.tickQuotaResume();
  expect(
    (await c.state()).sessions.find((s) => s.id === f.id)?.quotaPause?.state,
  ).toBe("completed");
  expect(f.requests).toHaveLength(2);
});
it("renderer reconnect cancels a local permission wait without losing opted-in quota resume", async () => {
  const f = await fixture();
  await f.c.handle({ type: "quota_resume", sessionId: f.id, action: "enable" });
  const job = f.c.handle({
    type: "project_skills",
    sessionId: f.id,
    request: { action: "list", requestId: "local" },
  });
  await vi.waitFor(() =>
    expect(f.events.some((e) => e.type === "permission_request")).toBe(true),
  );
  f.advance();
  await f.c.tickQuotaResume();
  expect(f.requests).toHaveLength(1);
  expect(await f.pause()).toMatchObject({ state: "waiting" });
  await f.c.handle({ type: "ready" });
  expect(await job).toMatchObject({ ok: false });
  expect(await f.pause()).toMatchObject({ state: "waiting" });
  expect(f.requests).toHaveLength(1);
  await f.c.tickQuotaResume();
  expect(await f.pause()).toMatchObject({ state: "completed", attempts: 1 });
  expect(f.requests).toHaveLength(2);
});
it.each([
  "config",
  "history",
  "HEAD",
  "brokenHEAD",
  "memory",
  "effort",
  "mode",
  "stop",
])("changed %s cannot launch a provider", async (change) => {
  const f = await fixture();
  await f.c.handle({ type: "quota_resume", sessionId: f.id, action: "enable" });
  if (change === "config")
    await writeFile(
      join(f.home, "config.yaml"),
      "workflow: {mode: off}\nweb: {enabled: false}\n",
    );
  if (change === "history")
    await f.sessions.append(
      f.id,
      [{ role: "user", content: [{ type: "text", text: "new task" }] }],
      (s) => s,
    );
  if (change === "HEAD") {
    await mkdir(join(f.root, ".git"));
    await writeFile(join(f.root, ".git", "HEAD"), "a".repeat(40));
  }
  if (change === "brokenHEAD") await mkdir(join(f.root, ".git"));
  if (change === "memory")
    await writeFile(join(f.root, "AGENTS.md"), "Changed task instructions");
  if (change === "effort")
    await f.c.handle({
      type: "set_model",
      sessionId: f.id,
      model: "fake",
      effort: "low",
    });
  if (change === "mode")
    await f.c.handle({ type: "set_mode", sessionId: f.id, mode: "plan" });
  if (change === "stop") await f.c.handle({ type: "abort", sessionId: f.id });
  f.advance();
  await f.c.tickQuotaResume();
  expect(f.requests).toHaveLength(1);
  expect((await f.pause())?.state).toBe(
    change === "stop" ? "cancelled" : "manual",
  );
});
it("unknown quota has a manual path and error does not create a quota job", async () => {
  const f = await fixture([{ type: "rate_limited" }, done]);
  expect(await f.pause()).toMatchObject({
    state: "manual",
    nextCheckAt: undefined,
  });
  await f.c.handle({ type: "quota_resume", sessionId: f.id, action: "now" });
  await f.c.tickQuotaResume();
  expect(f.requests).toHaveLength(2);
  const error = await fixture([{ type: "error", kind: "authentication" }]);
  expect(await error.pause()).toBeUndefined();
});
it("unsupported workflow remains manual without replaying the original task", async () => {
  const f = await fixture([quota], "manual");
  expect(await f.pause()).toMatchObject({ state: "manual", eligible: false });
  f.advance();
  await f.c.tickQuotaResume();
  expect(f.requests).toHaveLength(1);
});
it("continuation tools require fresh permission even in automatic mode", async () => {
  const write: FakeStep = {
    type: "message",
    stopReason: "tool_use",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "write",
          name: "Write",
          input: { path: "new.txt", content: "side effect" },
        },
      ],
    },
  };
  const f = await fixture([quota]);
  // Changing mode is a premise change, so create a new accepted instruction/checkpoint first.
  await f.c.handle({ type: "set_mode", sessionId: f.id, mode: "acceptEdits" });
  await f.c.shutdown();
  const c = f.create([quota, write, done]);
  await c.init();
  await c.handle({
    type: "send",
    sessionId: f.id,
    text: "Complete this task with automatic mode",
  });
  await vi.waitFor(async () =>
    expect((await c.state()).sessions.find((s) => s.id === f.id)).toMatchObject(
      { status: "idle", quotaPause: { eligible: true } },
    ),
  );
  await c.handle({ type: "quota_resume", sessionId: f.id, action: "enable" });
  f.advance();
  const pending = c.tickQuotaResume();
  await vi.waitFor(() =>
    expect(
      f.events.some(
        (e) => e.type === "permission_request" && e.tool === "Write",
      ),
      JSON.stringify(
        f.events
          .filter(
            (e) =>
              e.type === "state" || e.type === "turn" || e.type === "error",
          )
          .slice(-5),
      ),
    ).toBe(true),
  );
  const request = f.events.find(
    (e) => e.type === "permission_request" && e.tool === "Write",
  ) as Extract<UiEvent, { type: "permission_request" }>;
  await c.handle({
    type: "permission_response",
    sessionId: f.id,
    requestId: request.requestId,
    decision: "deny",
  });
  await pending;
  const { stat } = await import("node:fs/promises");
  await expect(stat(join(f.root, "new.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("a turn that already executed a tool is recorded as manual only", async () => {
  const call: FakeStep = {
    type: "message",
    stopReason: "tool_use",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "read",
          name: "Read",
          input: { path: "read.txt" },
        },
      ],
    },
  };
  const f = await fixture([call, quota]);
  expect(await f.pause()).toMatchObject({ state: "manual", eligible: false });
  expect(
    await f.c.handle({
      type: "quota_resume",
      sessionId: f.id,
      action: "enable",
    }),
  ).toMatchObject({ ok: false });
  f.advance();
  await f.c.tickQuotaResume();
  expect(f.requests).toHaveLength(2);
});
