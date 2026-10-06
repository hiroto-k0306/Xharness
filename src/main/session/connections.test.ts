import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionController } from "./controller.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import {
  developmentUiConnections,
  unavailableConnections,
  type UiConnections,
} from "../connections/ui-registry.js";
import { SessionStore } from "./store.js";
import { readTraceReplay } from "./report-trace.js";
import { parseCommand, type UiEvent } from "../../shared/ipc.js";
async function fixture(connections?: UiConnections) {
  const home = await mkdtemp(join(tmpdir(), "xh-connection-ui-"));
  const cwd = await mkdtemp(join(tmpdir(), "xh-connection-cwd-"));
  const events: UiEvent[] = [];
  const create = (
    registry = connections ?? developmentUiConnections(home, true),
  ) =>
    new SessionController({
      home,
      fake: true,
      model: "fake",
      phase4: true,
      version: "test",
      provider: new FakeProvider(),
      connections: registry,
      host: { pickFolder: async () => cwd },
      emit: (e) => events.push(e),
    });
  const c = create();
  await c.init();
  const result = await c.handle({ type: "new_session", workspaceId: null });
  if (!result.ok || !result.sessionId) throw new Error("No session");
  return { home, cwd, c, create, events, id: result.sessionId };
}
it("rejects malformed choices at IPC before they can reach the controller", () => {
  expect(
    parseCommand({
      type: "set_connection",
      sessionId: "s",
      connection: "paid-api",
    }),
  ).toBeUndefined();
  expect(
    parseCommand({
      type: "set_connection",
      sessionId: "s",
      connection: "claude-mcp",
    }),
  ).toMatchObject({ connection: "claude-mcp" });
});
it("repeated explicit selections survive restart and preserve model/config/auth files", async () => {
  const f = await fixture();
  const marker = "auth-placeholder-without-secrets";
  await writeFile(
    join(f.home, "config.yaml"),
    "main:\n  model: claude:haiku\n",
  );
  await writeFile(join(f.home, "auth-marker"), marker);
  for (const connection of [
    "claude-proposals",
    "claude-mcp",
    "legacy",
    "openai-siwc",
  ] as const)
    expect(
      (
        await f.c.handle({
          type: "set_connection",
          sessionId: f.id,
          connection,
        })
      ).ok,
    ).toBe(true);
  expect((await f.c.state()).sessions[0]).toMatchObject({
    connection: "openai-siwc",
    model: "fake",
  });
  await f.c.shutdown();
  const next = f.create(developmentUiConnections(f.home, false));
  await next.init();
  expect((await next.state()).sessions[0]).toMatchObject({
    connection: "openai-siwc",
    model: "fake",
  });
  expect(await readFile(join(f.home, "config.yaml"), "utf8")).toBe(
    "main:\n  model: claude:haiku\n",
  );
  expect(
    (await next.state()).connections?.find((v) => v.mode === "claude-mcp")
      ?.status,
  ).toBe("needs_auth");
  expect(await readFile(join(f.home, "auth-marker"), "utf8")).toBe(marker);
  await next.shutdown();
});
it("refuses unconfigured sending without history, provider dispatch or fallback", async () => {
  const f = await fixture();
  await f.c.handle({
    type: "set_connection",
    sessionId: f.id,
    connection: "openai-siwc",
  });
  const result = await f.c.handle({
    type: "send",
    sessionId: f.id,
    text: "Do not dispatch",
  });
  expect(result.ok).toBe(false);
  expect(f.events.filter((e) => e.type === "user_message")).toEqual([]);
  const store = new SessionStore(f.home);
  await store.load();
  expect(await store.messages(f.id)).toEqual([]);
  await f.c.shutdown();
});
it.each(["claude-proposals", "claude-mcp"] as const)(
  "runs selected %s through normal UI history/trace and freezes the connection once nonempty",
  async (connection) => {
    const f = await fixture();
    await f.c.handle({ type: "set_connection", sessionId: f.id, connection });
    expect(
      (await f.c.handle({ type: "send", sessionId: f.id, text: "Fixture" })).ok,
    ).toBe(true);
    await vi.waitFor(() =>
      expect(
        f.events.some(
          (e) =>
            e.type === "turn" &&
            e.status === "idle" &&
            e.stopCause === "end_turn",
        ),
      ).toBe(true),
    );
    const replay = await readTraceReplay(f.home, f.id, (text) => text);
    expect(
      f.events.some((e) => e.type === "text_delta" && e.text === "OK"),
    ).toBe(true);
    expect(replay?.records.some((r) => r.kind === "llm")).toBe(true);
    expect(
      (
        await f.c.handle({
          type: "set_connection",
          sessionId: f.id,
          connection: "legacy",
        })
      ).ok,
    ).toBe(false);
    await f.c.shutdown();
  },
);
it("cancels checking, rejects duplicate checks/sending, and does not persist availability", async () => {
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const registry: UiConnections = {
    views: unavailableConnections,
    selection: () => undefined,
    check: async (signal) => {
      entered();
      await new Promise<void>((r) =>
        signal.addEventListener("abort", () => r(), { once: true }),
      );
    },
  };
  const f = await fixture(registry);
  const checking = f.c.handle({ type: "check_connection", sessionId: f.id });
  await started;
  expect(
    (await f.c.handle({ type: "check_connection", sessionId: f.id })).ok,
  ).toBe(false);
  expect(
    (
      await f.c.handle({
        type: "send",
        sessionId: f.id,
        text: "Do not dispatch",
      })
    ).ok,
  ).toBe(false);
  await f.c.handle({ type: "check_connection", sessionId: f.id, cancel: true });
  expect((await checking).ok).toBe(false);
  expect(
    (await f.c.state()).connections?.find((v) => v.mode === "claude-mcp")
      ?.status,
  ).toBe("needs_auth");
  await f.c.shutdown();
});
it("stops before dispatch instead of bypassing configured X hooks", async () => {
  const f = await fixture();
  await writeFile(
    join(f.home, "config.yaml"),
    "hooks:\n  - id: protect\n    step: model\n    timing: before\n    onMatch: block\n    reason: Stop\n",
  );
  await f.c.handle({
    type: "set_connection",
    sessionId: f.id,
    connection: "claude-mcp",
  });
  await f.c.handle({ type: "send", sessionId: f.id, text: "Fixture" });
  await vi.waitFor(() =>
    expect(
      f.events.some(
        (e) =>
          e.type === "turn" &&
          e.status === "idle" &&
          e.stopCause === "step_failed",
      ),
    ).toBe(true),
  );
  expect(
    f.events.some(
      (e) => e.type === "receipt" && e.receipt.kind === "model_call",
    ),
  ).toBe(false);
  expect(
    f.events.some((e) => e.type === "error" && e.message.includes("フック")),
  ).toBe(true);
  await f.c.shutdown();
});
