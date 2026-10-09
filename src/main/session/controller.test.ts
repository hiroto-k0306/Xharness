import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type UiEvent } from "../../shared/ipc.js";
import {
  type OfficialSessionSubmission,
  type OfficialSessionResult,
} from "../../shared/official-session.js";
import { defaultTools, SessionController, type Host } from "./controller.js";
import { SessionStore } from "./store.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";

let home: string;
let workspace: string;
let events: UiEvent[];
const controllers: SessionController[] = [];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "xh-controller-home-"));
  workspace = await mkdtemp(join(tmpdir(), "xh-controller-ws-"));
  events = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const controller of controllers.splice(0)) await controller.shutdown();
});
const result: OfficialSessionResult = {
  summary: "official answer",
  workflowId: "offline-workflow",
  status: "completed",
};
function make(
  options: {
    host?: Partial<Host>;
    secrets?: string[];
    model?: string;
    effort?: "low" | "high";
    warnings?: string[];
    run?: (
      request: OfficialSessionSubmission,
      signal: AbortSignal,
    ) => Promise<OfficialSessionResult>;
  } = {},
) {
  const official = vi.fn(options.run ?? (async () => result));
  const controller = new SessionController({
    provider: new FakeProvider({
      onRequest: () => {
        throw new Error("Legacy provider must not be called");
      },
    }),
    model: options.model ?? "claude-opus-5-5",
    effort: options.effort ?? "high",
    home,
    fake: true,
    version: "test",
    secrets: options.secrets,
    warnings: options.warnings,
    officialSession: official,
    host: { pickFolder: async () => workspace, ...options.host },
    emit: (event) => events.push(event),
  });
  controllers.push(controller);
  return { controller, official };
}
async function newId(
  controller: SessionController,
  workspaceId: string | null = null,
) {
  const created = await controller.handle({ type: "new_session", workspaceId });
  if (!created.ok || !created.sessionId) throw new Error("missing session");
  return created.sessionId;
}
async function idle(controller: SessionController, id: string) {
  await vi.waitFor(async () =>
    expect(
      (await controller.state()).sessions.find((s) => s.id === id)?.status,
    ).toBe("idle"),
  );
}
async function send(controller: SessionController, id: string, text: string) {
  expect(
    await controller.handle({ type: "send", sessionId: id, text }),
  ).toMatchObject({ ok: true });
  await idle(controller, id);
}
function pending() {
  let started = false,
    cancelled = false;
  const run = async (
    _request: OfficialSessionSubmission,
    signal: AbortSignal,
  ): Promise<OfficialSessionResult> => {
    started = true;
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          cancelled = true;
          resolve();
        },
        { once: true },
      ),
    );
    return { ...result, status: "cancelled" };
  };
  return { run, started: () => started, cancelled: () => cancelled };
}
it("registers no legacy tools in either access mode", () => {
  expect(defaultTools(workspace, false).size).toBe(0);
  expect(defaultTools(workspace, true).size).toBe(0);
});
it("creates a scratch session without a workspace", async () => {
  const { controller } = make();
  await controller.init();
  const id = await newId(controller);
  expect(
    (await controller.state()).sessions.find((s) => s.id === id),
  ).toMatchObject({ workspaceId: null, title: "New session" });
  expect((await controller.state()).sessions[0]!.cwd).toContain(
    join(home, "scratch"),
  );
});
it("remembers a workspace and persists an official text turn", async () => {
  const { controller, official } = make();
  await controller.init();
  const picked = await controller.handle({ type: "pick_folder" });
  if (!picked.ok || !picked.workspaceId) throw new Error("missing workspace");
  const id = await newId(controller, picked.workspaceId);
  await send(controller, id, "hello there");
  expect(official.mock.calls[0]![0]).toMatchObject({
    cwd: workspace,
    text: "hello there",
  });
  expect((await controller.state()).workspaces[0]).toMatchObject({
    id: picked.workspaceId,
  });
  expect(
    (await controller.state()).sessions.find((s) => s.id === id),
  ).toMatchObject({ title: "hello there", status: "idle" });
  expect(
    (await new SessionStore(home).messages(id)).map((m) => m.role),
  ).toEqual(["user", "assistant"]);
});
it("exports saved history and handles cancellation and unknown sessions", async () => {
  const output = join(home, "report.html");
  const saveReport = vi.fn(async () => output as string | undefined);
  const { controller } = make({ host: { saveReport } });
  await controller.init();
  const id = await newId(controller);
  await send(controller, id, "hello");
  expect(
    await controller.handle({ type: "export_report", sessionId: id }),
  ).toEqual({ ok: true });
  expect(saveReport).toHaveBeenCalledOnce();
  expect(await readFile(output, "utf8")).toContain("hello");
  saveReport.mockResolvedValueOnce(undefined);
  expect(
    await controller.handle({ type: "export_report", sessionId: id }),
  ).toEqual({ ok: false, error: "cancelled" });
  expect(
    await controller.handle({ type: "export_report", sessionId: "missing" }),
  ).toEqual({ ok: false, error: "Unknown session" });
});
it("forgets a workspace while preserving its sessions", async () => {
  const { controller } = make();
  await controller.init();
  const picked = await controller.handle({ type: "pick_folder" });
  if (!picked.ok || !picked.workspaceId) throw new Error("missing workspace");
  const id = await newId(controller, picked.workspaceId);
  await controller.handle({
    type: "forget_workspace",
    workspaceId: picked.workspaceId,
  });
  expect((await controller.state()).workspaces).toHaveLength(0);
  expect(
    (await controller.state()).sessions.find((s) => s.id === id),
  ).toBeDefined();
});
it("reopens saved history and passes only that history to the next official submission", async () => {
  const first = make();
  await first.controller.init();
  const id = await newId(first.controller);
  await send(first.controller, id, "first");
  await first.controller.shutdown();
  const again = make();
  await again.controller.init();
  await again.controller.handle({ type: "open_session", sessionId: id });
  expect(
    events.some((e) => e.type === "transcript" && e.items.length === 2),
  ).toBe(true);
  await send(again.controller, id, "second");
  expect(again.official.mock.calls[0]![0].history).toEqual([
    { role: "user", text: "first" },
    { role: "assistant", text: "official answer" },
  ]);
  expect(
    (await new SessionStore(home).messages(id)).map((m) => m.role),
  ).toEqual(["user", "assistant", "user", "assistant"]);
});
it("masks known secrets in persisted official results and UI events", async () => {
  const { controller } = make({
    secrets: ["private-token"],
    run: async () => ({ ...result, summary: "private-token" }),
  });
  await controller.init();
  const id = await newId(controller);
  await send(controller, id, "private-token");
  expect(
    await readFile(join(home, "sessions", id + ".jsonl"), "utf8"),
  ).not.toContain("private-token");
  expect(JSON.stringify(events)).not.toContain("private-token");
});
it("preserves session-specific model and effort across restart", async () => {
  const { controller } = make();
  await controller.init();
  const a = await newId(controller),
    b = await newId(controller);
  expect(
    await controller.handle({
      type: "set_model",
      sessionId: a,
      model: "claude-sonnet-5-5",
      effort: "low",
    }),
  ).toMatchObject({ ok: true });
  expect(
    (await controller.state()).sessions.find((s) => s.id === b),
  ).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
  await controller.shutdown();
  const restarted = make();
  await restarted.controller.init();
  expect(
    (await restarted.controller.state()).sessions.find((s) => s.id === a),
  ).toMatchObject({ model: "claude-sonnet-5-5", effort: "low" });
  await send(restarted.controller, a, "continue");
  expect(restarted.official.mock.calls[0]![0]).toMatchObject({
    model: "claude:claude-sonnet-5-5",
    effort: "low",
  });
});
it("rejects unknown models and sessions without dispatch and handles picker cancellation", async () => {
  const { controller, official } = make({
    host: { pickFolder: async () => undefined },
  });
  await controller.init();
  const id = await newId(controller);
  expect(
    await controller.handle({
      type: "send",
      sessionId: "missing",
      text: "hello",
    }),
  ).toMatchObject({ ok: false });
  expect(
    await controller.handle({
      type: "set_model",
      sessionId: id,
      model: "unknown-model",
    }),
  ).toMatchObject({ ok: false });
  expect(
    await controller.handle({
      type: "set_model",
      sessionId: "missing",
      model: "claude-sonnet-5-5",
    }),
  ).toMatchObject({ ok: false });
  expect(await controller.handle({ type: "pick_folder" })).toMatchObject({
    ok: false,
  });
  expect(official).not.toHaveBeenCalled();
});
it("fills model defaults in historical sessions and reports startup warnings once", async () => {
  await mkdir(join(home, "sessions"), { recursive: true });
  await writeFile(
    join(home, "sessions", "index.json"),
    JSON.stringify([
      {
        id: "old",
        title: "old",
        cwd: workspace,
        workspaceId: null,
        readOnly: false,
        createdAt: 0,
        updatedAt: 0,
        providers: [],
      },
    ]),
  );
  const { controller } = make({ warnings: ["startup-warning"] });
  await controller.init();
  expect(
    (await controller.state()).sessions.find((s) => s.id === "old"),
  ).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
  await newId(controller);
  await newId(controller);
  expect(
    events.filter(
      (e) => e.type === "error" && e.message.includes("startup-warning"),
    ),
  ).toHaveLength(1);
});
it.each(["missing", "file"])(
  "rejects a %s working directory without dispatch and preserves readable history",
  async (kind) => {
    const { controller, official } = make();
    await controller.init();
    const picked = await controller.handle({ type: "pick_folder" });
    if (!picked.ok || !picked.workspaceId) throw new Error("missing workspace");
    const id = await newId(controller, picked.workspaceId);
    await send(controller, id, "saved");
    await rm(workspace, { recursive: true, force: true });
    if (kind === "file") await writeFile(workspace, "not a folder");
    official.mockClear();
    events.length = 0;
    expect(
      await controller.handle({ type: "send", sessionId: id, text: "next" }),
    ).toMatchObject({ ok: false });
    expect(official).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).toContain("作業フォルダが見つかりません");
    await controller.handle({ type: "open_session", sessionId: id });
    expect(
      events.some((e) => e.type === "transcript" && e.items.length === 2),
    ).toBe(true);
    expect(
      await controller.handle({
        type: "new_session",
        workspaceId: picked.workspaceId,
      }),
    ).toMatchObject({ ok: false });
  },
);
it("releases the send reservation after cwd failure so restoring the folder allows a later turn", async () => {
  const { controller, official } = make();
  await controller.init();
  const picked = await controller.handle({ type: "pick_folder" });
  if (!picked.ok || !picked.workspaceId) throw new Error("missing workspace");
  const id = await newId(controller, picked.workspaceId);
  const cwd = (await controller.state()).sessions.find((s) => s.id === id)!.cwd;
  await rm(cwd, { recursive: true, force: true });
  expect(
    await controller.handle({ type: "send", sessionId: id, text: "first" }),
  ).toMatchObject({ ok: false });
  await mkdir(cwd, { recursive: true });
  await send(controller, id, "second");
  expect(official).toHaveBeenCalledOnce();
});
it.each(["close", "shutdown"])(
  "cancels pending official execution on %s and persists input",
  async (action) => {
    const held = pending();
    const { controller } = make({ run: held.run });
    await controller.init();
    const id = await newId(controller);
    await controller.handle({ type: "send", sessionId: id, text: "hold" });
    await vi.waitFor(() => expect(held.started()).toBe(true));
    if (action === "close")
      await controller.handle({ type: "close_session", sessionId: id });
    else await controller.shutdown();
    await vi.waitFor(() => expect(held.cancelled()).toBe(true));
    expect((await new SessionStore(home).messages(id))[0]?.role).toBe("user");
  },
);
it("shutdown refuses new work and is safe with no running session", async () => {
  const { controller, official } = make();
  await controller.init();
  const id = await newId(controller);
  await controller.shutdown();
  await controller.shutdown();
  expect(
    await controller.handle({ type: "send", sessionId: id, text: "late" }),
  ).toMatchObject({ ok: false });
  expect(official).not.toHaveBeenCalled();
});
it("closing an idle session preserves its saved history", async () => {
  const { controller } = make();
  await controller.init();
  const id = await newId(controller);
  await send(controller, id, "saved");
  await controller.handle({ type: "close_session", sessionId: id });
  await controller.handle({ type: "open_session", sessionId: id });
  expect(await new SessionStore(home).messages(id)).toHaveLength(2);
});
it("accepts exactly one simultaneous submission per session", async () => {
  const held = pending();
  const { controller, official } = make({ run: held.run });
  await controller.init();
  const id = await newId(controller);
  const outcomes = await Promise.all([
    controller.handle({ type: "send", sessionId: id, text: "one" }),
    controller.handle({ type: "send", sessionId: id, text: "two" }),
  ]);
  expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
  await vi.waitFor(() => expect(official).toHaveBeenCalledOnce());
  await controller.handle({ type: "abort", sessionId: id });
  await idle(controller, id);
});
it("does not overwrite history when reopened sessions receive simultaneous sends", async () => {
  const first = make();
  await first.controller.init();
  const id = await newId(first.controller);
  await send(first.controller, id, "first");
  await first.controller.shutdown();
  const again = make();
  await again.controller.init();
  const outcomes = await Promise.all([
    again.controller.handle({ type: "send", sessionId: id, text: "second" }),
    again.controller.handle({ type: "send", sessionId: id, text: "third" }),
  ]);
  expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
  await idle(again.controller, id);
  expect(again.official).toHaveBeenCalledOnce();
  expect(
    (await new SessionStore(home).messages(id)).map((m) => m.role),
  ).toEqual(["user", "assistant", "user", "assistant"]);
});
it("reads history once when open and send race and retains later turns", async () => {
  const first = make();
  await first.controller.init();
  const id = await newId(first.controller);
  await send(first.controller, id, "first");
  await first.controller.shutdown();
  const original = SessionStore.prototype.messages;
  let reads = 0;
  vi.spyOn(SessionStore.prototype, "messages").mockImplementation(
    async function (this: SessionStore, sessionId) {
      const messages = await original.call(this, sessionId);
      reads++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return messages;
    },
  );
  const again = make();
  await again.controller.init();
  const opening = again.controller.handle({
    type: "open_session",
    sessionId: id,
  });
  await send(again.controller, id, "second");
  await opening;
  await send(again.controller, id, "third");
  expect(reads).toBe(1);
  expect(again.official.mock.calls.map(([r]) => r.history?.length)).toEqual([
    2, 4,
  ]);
});
it("reports a corrupt session index after moving it aside", async () => {
  await mkdir(join(home, "sessions"), { recursive: true });
  await writeFile(join(home, "sessions", "index.json"), "{broken");
  const { controller } = make();
  await controller.init();
  await newId(controller);
  expect(JSON.stringify(events.filter((e) => e.type === "error"))).toContain(
    "退避",
  );
});
it("rejects another writing session in the same workspace before official dispatch", async () => {
  const held = pending();
  const { controller, official } = make({ run: held.run });
  await controller.init();
  const picked = await controller.handle({ type: "pick_folder" });
  if (!picked.ok || !picked.workspaceId) throw new Error("missing workspace");
  const a = await newId(controller, picked.workspaceId);
  const b = await newId(controller, picked.workspaceId);
  expect(
    await controller.handle({ type: "send", sessionId: a, text: "hold" }),
  ).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(held.started()).toBe(true));
  expect(
    await controller.handle({
      type: "send",
      sessionId: b,
      text: "second writer",
    }),
  ).toEqual({ ok: false, error: "Workspace writer busy" });
  expect(official).toHaveBeenCalledOnce();
  await controller.handle({ type: "abort", sessionId: a });
  await idle(controller, a);
});
