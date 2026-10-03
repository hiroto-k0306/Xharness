import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionSchedules } from "./schedules.js";
import { SessionController } from "./controller.js";
import { WorkspaceTrust } from "../config/trust.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { type UiEvent } from "../../shared/ipc.js";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture() {
  let now = 0,
    busy = false;
  const send = vi.fn(async () => ({ ok: true as const }));
  const notice = vi.fn();
  const jobs = new SessionSchedules({
    now: () => now,
    busy: () => busy,
    send,
    notice,
  });
  return {
    jobs,
    send,
    notice,
    advance: (ms: number) => {
      now += ms;
    },
    busy: (value: boolean) => {
      busy = value;
    },
  };
}
it("uses the timer for delayed work and clears timers on shutdown", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const send = vi.fn(async () => ({ ok: true as const }));
  const jobs = new SessionSchedules({
    now: Date.now,
    busy: () => false,
    send,
    notice: () => {},
  });
  jobs.command("owner", "/schedule after 2 work");
  await vi.advanceTimersByTimeAsync(1000);
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(send).toHaveBeenCalledTimes(1);
  jobs.close();
  expect(vi.getTimerCount()).toBe(0);
});
it("removes failed repeats without automatic retries", async () => {
  let now = 0;
  const send = vi.fn(async () => ({ ok: false as const, error: "rejected" }));
  const jobs = new SessionSchedules({
    now: () => now,
    busy: () => false,
    send,
    notice: () => {},
  });
  jobs.command("owner", "/schedule every 60 20 work");
  now = 60000;
  await jobs.tick();
  now = 999999;
  await jobs.tick();
  expect(send).toHaveBeenCalledTimes(1);
  jobs.close();
});
it("does not cancel foreign IDs or trigger work from list/help", async () => {
  const s = fixture();
  s.jobs.command("owner", "/schedule after 1 work");
  const registered = s.notice.mock.calls[0]![1] as string;
  const id = /予約 ([\w-]+)/.exec(registered)![1];
  expect(s.jobs.command("other", "/schedule cancel " + id).ok).toBe(false);
  s.jobs.command("owner", "/schedule list");
  s.jobs.command("owner", "/schedule help");
  expect(s.send).not.toHaveBeenCalled();
  s.advance(1000);
  await s.jobs.tick();
  expect(s.send).toHaveBeenCalledTimes(1);
  s.jobs.close();
});
it("claims due jobs once under concurrent ticks and coalesces overdue repeats", async () => {
  const s = fixture();
  s.jobs.command("owner", "/schedule every 60 2 do work");
  s.advance(600000);
  s.busy(true);
  await s.jobs.tick();
  expect(s.send).not.toHaveBeenCalled();
  s.busy(false);
  await Promise.all([s.jobs.tick(), s.jobs.tick()]);
  expect(s.send).toHaveBeenCalledTimes(1);
  await s.jobs.tick();
  expect(s.send).toHaveBeenCalledTimes(1);
  s.advance(60000);
  await s.jobs.tick();
  expect(s.send).toHaveBeenCalledTimes(2);
  s.advance(60000);
  await s.jobs.tick();
  expect(s.send).toHaveBeenCalledTimes(2);
  s.jobs.close();
});
it("fires named and idle events only for their owner and only after registration", async () => {
  const s = fixture();
  s.jobs.command("owner", "/signal ready");
  s.jobs.command("owner", "/schedule event ready inspect");
  s.jobs.command("owner", "/schedule idle inspect idle");
  s.jobs.command("other", "/signal ready");
  s.jobs.idle("other");
  await s.jobs.tick();
  expect(s.send).not.toHaveBeenCalled();
  s.jobs.command("owner", "/signal ready");
  await s.jobs.tick();
  expect(s.send).toHaveBeenCalledTimes(1);
  s.jobs.idle("owner");
  await s.jobs.tick();
  expect(s.send).toHaveBeenCalledTimes(2);
  s.jobs.idle("owner");
  s.jobs.command("owner", "/signal ready");
  await s.jobs.tick();
  expect(s.send).toHaveBeenCalledTimes(2);
  s.jobs.close();
});
it("cancellation aborts a claimed launch and prevents repeat re-registration", async () => {
  let release!: (v: { ok: true }) => void;
  let signal: AbortSignal | undefined;
  const send = vi.fn((_id: string, _text: string, s: AbortSignal) => {
    signal = s;
    return new Promise<{ ok: true }>((r) => {
      release = r;
    });
  });
  const jobs = new SessionSchedules({
    now: () => 100000,
    busy: () => false,
    send,
    notice: () => {},
  });
  jobs.command("owner", "/schedule event ready work");
  jobs.command("owner", "/signal ready");
  const pending = jobs.tick();
  jobs.cancel("owner");
  expect(signal!.aborted).toBe(true);
  release({ ok: true });
  await pending;
  await jobs.tick();
  expect(send).toHaveBeenCalledTimes(1);
  jobs.close();
});
it.each([
  "/schedule after 0 work",
  "/schedule every 59 2 work",
  "/schedule every 60 21 work",
  "/schedule after 604801 work",
  "/schedule after 1 /schedule after 1 work",
  "/schedule event bad/name work",
  "/schedule after 1 " + "x".repeat(4001),
])("rejects invalid or recursive schedules: %s", (command) => {
  const s = fixture();
  expect(s.jobs.command("owner", command).ok).toBe(false);
  expect(s.send).not.toHaveBeenCalled();
  s.jobs.close();
});
it("enforces per-session/global bounds, expiry, failure and shutdown", async () => {
  const s = fixture();
  for (const id of ["a", "b", "c", "d"])
    for (let i = 0; i < 5; i++)
      expect(s.jobs.command(id, "/schedule event x work").ok).toBe(true);
  expect(s.jobs.command("a", "/schedule after 1 work").ok).toBe(false);
  expect(s.jobs.command("e", "/schedule after 1 work").ok).toBe(false);
  s.advance(604800001);
  await s.jobs.tick();
  expect(s.send).not.toHaveBeenCalled();
  s.jobs.close();
  expect(s.jobs.command("a", "/schedule after 1 work").ok).toBe(false);
});
async function controllerFixture(workspace?: string) {
  const home = await mkdtemp(join(tmpdir(), "xh-schedule-controller-"));
  const events: UiEvent[] = [],
    onRequest = vi.fn();
  const controller = new SessionController({
    home,
    model: "fake",
    provider: new FakeProvider({
      script: [
        {
          type: "message",
          stopReason: "end_turn",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "offline answer" }],
          },
        },
      ],
      onRequest,
    }),
    fake: true,
    version: "test",
    host: { pickFolder: async () => workspace },
    emit: (e) => events.push(e),
    createTools: () => new Map(),
  });
  await controller.init();
  const picked = workspace
    ? await controller.handle({ type: "pick_folder" })
    : undefined;
  const created = await controller.handle({
    type: "new_session",
    workspaceId: picked?.ok ? picked.workspaceId! : null,
  });
  if (!created.ok || !created.sessionId) throw new Error("fixture");
  return {
    controller,
    home,
    events,
    onRequest,
    id: created.sessionId,
    send: (text: string) =>
      controller.handle({ type: "send", sessionId: created.sessionId!, text }),
  };
}
// Drive the actual registry without waiting on wall-clock or starting the app.
const registry = (controller: SessionController) =>
  (controller as unknown as { schedules: SessionSchedules }).schedules;
it("scheduled tool work still asks for permission and honors denial", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-scheduled-permission-"));
  const workspace = await mkdtemp(
    join(tmpdir(), "xh-scheduled-permission-ws-"),
  );
  const events: UiEvent[] = [],
    execute = vi.fn(async () => ({ content: "must not execute" }));
  const controller = new SessionController({
    home,
    model: "fake",
    fake: true,
    version: "test",
    host: { pickFolder: async () => workspace },
    emit: (e) => events.push(e),
    provider: new FakeProvider({
      script: [
        {
          type: "message",
          stopReason: "tool_use",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "write",
                name: "Read",
                input: { path: "a.txt" },
              },
            ],
          },
        },
        {
          type: "message",
          stopReason: "end_turn",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "denied" }],
          },
        },
      ],
    }),
    createTools: () =>
      new Map([
        [
          "Read",
          {
            spec: { name: "Read", description: "mock", inputSchema: {} },
            readOnly: true,
            validate: async () => undefined,
            execute,
          },
        ],
      ]),
  });
  await controller.init();
  const picked = await controller.handle({ type: "pick_folder" });
  if (!picked.ok || !picked.workspaceId) throw new Error("fixture workspace");
  const created = await controller.handle({
    type: "new_session",
    workspaceId: picked.workspaceId,
  });
  if (!created.ok || !created.sessionId) throw new Error("fixture");
  const id = created.sessionId;
  await controller.handle({
    type: "send",
    sessionId: id,
    text: "/schedule event ready write a file",
  });
  await controller.handle({
    type: "send",
    sessionId: id,
    text: "/signal ready",
  });
  await registry(controller).tick();
  await vi.waitFor(() =>
    expect(events.some((e) => e.type === "permission_request")).toBe(true),
  );
  const request = events.find(
    (e) => e.type === "permission_request",
  ) as Extract<UiEvent, { type: "permission_request" }>;
  await controller.handle({
    type: "permission_response",
    sessionId: id,
    requestId: request.requestId,
    decision: "deny",
  });
  await (
    controller as unknown as { runtimes: Map<string, { done?: Promise<void> }> }
  ).runtimes.get(id)?.done;
  expect(execute).not.toHaveBeenCalled();
  await controller.shutdown();
});
it("idle schedules follow successful completion once and never start at registration", async () => {
  const s = await controllerFixture();
  await s.send("/schedule idle follow up");
  await registry(s.controller).tick();
  expect(s.onRequest).not.toHaveBeenCalled();
  await s.send("first ordinary message");
  await (
    s.controller as unknown as {
      runtimes: Map<string, { done?: Promise<void> }>;
    }
  ).runtimes.get(s.id)?.done;
  expect(s.onRequest).toHaveBeenCalledTimes(1);
  await registry(s.controller).tick();
  await (
    s.controller as unknown as {
      runtimes: Map<string, { done?: Promise<void> }>;
    }
  ).runtimes.get(s.id)?.done;
  expect(s.onRequest).toHaveBeenCalledTimes(2);
  await registry(s.controller).tick();
  expect(s.onRequest).toHaveBeenCalledTimes(2);
  await s.controller.shutdown();
});
it("controller registers without model calls, sends through the normal budget, and does not recover jobs on restart", async () => {
  const s = await controllerFixture();
  await writeFile(
    join(s.home, "config.yaml"),
    "limits: {llmCallsPerSession: 1}\n",
  );
  await s.send("/schedule event ready normal text");
  expect(s.onRequest).not.toHaveBeenCalled();
  await s.send("/signal ready");
  await registry(s.controller).tick();
  // Wait for asynchronous persistence/turn completion, using its actual done Promise.
  await (
    s.controller as unknown as {
      runtimes: Map<string, { done?: Promise<void> }>;
    }
  ).runtimes.get(s.id)?.done;
  expect(s.onRequest).toHaveBeenCalledTimes(1);
  await s.send("/schedule event ready more text");
  await s.send("/signal ready");
  await registry(s.controller).tick();
  await (
    s.controller as unknown as {
      runtimes: Map<string, { done?: Promise<void> }>;
    }
  ).runtimes.get(s.id)?.done;
  expect(s.onRequest).toHaveBeenCalledTimes(1);
  expect(
    s.events.some(
      (e) => e.type === "turn" && e.stopCause === "budget_exceeded",
    ),
  ).toBe(true);
  await s.controller.shutdown();
  const restarted = new SessionController({
    home: s.home,
    model: "fake",
    provider: new FakeProvider({ onRequest: s.onRequest }),
    fake: true,
    version: "test",
    host: { pickFolder: async () => undefined },
    emit: () => {},
    createTools: () => new Map(),
  });
  await restarted.init();
  await registry(restarted).tick();
  expect(s.onRequest).toHaveBeenCalledTimes(1);
  await restarted.shutdown();
});
it.each(["abort", "close_session", "shutdown"] as const)(
  "%s cancels scheduler launches paused during preparation",
  async (action) => {
    const workspace = await mkdtemp(join(tmpdir(), "xh-schedule-workspace-"));
    const s = await controllerFixture(workspace);
    let entered!: () => void, release!: (v: boolean) => void;
    const waiting = new Promise<void>((r) => {
      entered = r;
    });
    const held = new Promise<boolean>((r) => {
      release = r;
    });
    await s.send("/schedule event ready normal text");
    await s.send("/signal ready");
    vi.spyOn(WorkspaceTrust.prototype, "isTrusted").mockImplementationOnce(
      () => {
        entered();
        return held;
      },
    );
    const pending = registry(s.controller).tick();
    await waiting;
    const stopped =
      action === "shutdown"
        ? s.controller.shutdown()
        : s.controller.handle({ type: action, sessionId: s.id });
    release(true);
    await pending;
    await stopped;
    expect(s.onRequest).not.toHaveBeenCalled();
    await registry(s.controller).tick();
    expect(s.onRequest).not.toHaveBeenCalled();
    await s.controller.shutdown();
  },
);
