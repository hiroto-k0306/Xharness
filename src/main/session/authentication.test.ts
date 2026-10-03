import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionController } from "./controller.js";
import { Authentication } from "../auth/authentication.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { type AuthenticationView, type UiEvent } from "../../shared/ipc.js";

async function setup(fake = false, authError = false) {
  const home = await mkdtemp(join(tmpdir(), "xh-controller-auth-"));
  const events: UiEvent[] = [];
  let status: AuthenticationView["status"] = "expired";
  const secrets: string[] = [];
  const confirm = vi.fn(async () => true);
  const launch = vi.fn(async () => {
    status = "available";
    return true;
  });
  const authentication = new Authentication({
    read: async (provider) => ({ provider, status }),
    confirm,
    launch,
    refreshSecrets: async () => {
      secrets.splice(0, secrets.length, "synthetic-new-credential");
    },
    changed: () => {},
  });
  const request = vi.fn();
  const controller = new SessionController({
    home,
    fake,
    version: "test",
    authentication,
    secrets,
    provider: new FakeProvider({
      onRequest: request,
      script: authError
        ? [{ type: "error", kind: "authentication" }]
        : [
            {
              type: "message",
              stopReason: "end_turn",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "synthetic-new-credential" }],
              },
            },
          ],
    }),
    model: "claude-haiku-4-5-20251001",
    host: { pickFolder: async () => home },
    emit: (e) => events.push(e),
  });
  await controller.init();
  const session = await controller.handle({
    type: "new_session",
    workspaceId: null,
  });
  if (!session.ok || !session.sessionId) throw new Error("Session not created");
  return {
    controller,
    authentication,
    confirm,
    launch,
    request,
    events,
    sessionId: session.sessionId,
  };
}
it("rejects sends while expired, allows login only through consent, and masks refreshed secrets", async () => {
  const s = await setup();
  expect((await s.controller.state()).authentication?.[0]?.status).toBe(
    "expired",
  );
  expect(
    await s.controller.handle({
      type: "send",
      sessionId: s.sessionId,
      text: "hello",
    }),
  ).toMatchObject({ ok: false });
  expect(s.request).not.toHaveBeenCalled();
  expect(
    await s.controller.handle({
      type: "send",
      sessionId: s.sessionId,
      text: "/compact",
    }),
  ).toMatchObject({ ok: false });
  expect(s.launch).not.toHaveBeenCalled();
  await s.controller.handle({ type: "authenticate", provider: "claude" });
  expect(s.confirm).toHaveBeenCalledOnce();
  expect(s.launch).toHaveBeenCalledOnce();
  expect(
    await s.controller.handle({
      type: "send",
      sessionId: s.sessionId,
      text: "hello",
    }),
  ).toMatchObject({ ok: true });
  await vi.waitFor(
    () =>
      expect(
        s.events.some((e) => e.type === "turn" && e.status === "idle"),
      ).toBe(true),
    { timeout: 5000 },
  );
  expect(s.request).toHaveBeenCalledOnce();
  expect(JSON.stringify(s.events)).not.toContain("synthetic-new-credential");
}, 10000);
it("keeps fake mode free of authentication reads and CLI execution", async () => {
  const s = await setup(true);
  expect((await s.controller.state()).authentication).toBeUndefined();
  expect(s.authentication.snapshot()).toEqual([]);
  expect(
    await s.controller.handle({ type: "authenticate", provider: "claude" }),
  ).toMatchObject({ ok: false });
  await s.controller.handle({ type: "refresh_auth" });
  expect(s.confirm).not.toHaveBeenCalled();
  expect(s.launch).not.toHaveBeenCalled();
});
it("refuses authentication during a running turn", async () => {
  const s = await setup();
  await s.controller.handle({ type: "authenticate", provider: "claude" });
  await s.controller.handle({
    type: "send",
    sessionId: s.sessionId,
    text: "hello",
  });
  expect(
    await s.controller.handle({ type: "authenticate", provider: "codex" }),
  ).toMatchObject({ ok: false });
  expect(s.launch).toHaveBeenCalledOnce();
  await s.controller.shutdown();
});
it("marks a provider rejection as needing reauthentication without automatically launching the CLI", async () => {
  const s = await setup(false, true);
  await s.controller.handle({ type: "authenticate", provider: "claude" });
  await s.controller.handle({
    type: "send",
    sessionId: s.sessionId,
    text: "hello",
  });
  await vi.waitFor(
    () =>
      expect(
        s.events.some(
          (e) => e.type === "turn" && e.stopCause === "authentication",
        ),
      ).toBe(true),
    { timeout: 5000 },
  );
  expect(
    (await s.controller.state()).authentication?.find(
      (v) => v.provider === "claude",
    )?.status,
  ).toBe("rejected");
  expect(s.launch).toHaveBeenCalledOnce();
}, 10000);
