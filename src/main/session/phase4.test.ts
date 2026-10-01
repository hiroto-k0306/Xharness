import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionController } from "./controller.js";
import { type UiEvent } from "../../shared/ipc.js";
import { type Provider, type ProviderRequest } from "../providers/provider.js";
import { type Tool } from "../tools/registry.js";
import { SessionStore } from "./store.js";
async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
it("resumes original history after manual compact, sends the compact view and retains project memory", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-compact-integration-"));
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    id: "claude",
    models: () => [{ id: "fake", contextTokens: 1000000 }],
    async *stream(request) {
      requests.push(request);
      yield {
        type: "message_done",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
        message: {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
        },
      };
    },
  };
  await writeFile(join(home, "AGENTS.md"), "GLOBAL MEMORY");
  let events: UiEvent[] = [];
  const make = () =>
    new SessionController({
      home,
      provider,
      model: "fake",
      phase4: true,
      fake: true,
      version: "test",
      host: { pickFolder: async () => undefined },
      createTools: () => new Map(),
      emit: (e) => events.push(e),
    });
  const c = make();
  await c.init();
  const created = await c.handle({ type: "new_session", workspaceId: null });
  if (!created.ok || !created.sessionId) throw new Error("create failed");
  const id = created.sessionId;
  for (let n = 0; n < 4; n++) {
    events = [];
    await c.handle({ type: "send", sessionId: id, text: `turn ${n}` });
    await until(() =>
      events.some((e) => e.type === "turn" && e.status === "idle"),
    );
  }
  const before = await readFile(join(home, "sessions", `${id}.jsonl`), "utf8");
  await c.handle({ type: "send", sessionId: id, text: "/compact" });
  expect(await readFile(join(home, "sessions", `${id}.jsonl`), "utf8")).toBe(
    before,
  );
  await c.shutdown();
  events = [];
  const resumed = make();
  await resumed.init();
  await resumed.handle({ type: "open_session", sessionId: id });
  expect(
    events.some((e) => e.type === "transcript" && e.items.length === 8),
  ).toBe(true);
  await resumed.handle({ type: "send", sessionId: id, text: "next" });
  await until(() =>
    events.some((e) => e.type === "turn" && e.status === "idle"),
  );
  expect(requests.at(-1)?.system).toContain("GLOBAL MEMORY");
  expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
    "Condensed earlier conversation",
  );
  expect(await readFile(join(home, "sessions", `${id}.jsonl`), "utf8")).toMatch(
    new RegExp(`^${before.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  await resumed.shutdown();
});
it("applies project model and effort while preserving explicit CLI precedence", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-project-model-"));
  const root = await mkdtemp(join(tmpdir(), "xh-project-root-"));
  await mkdir(join(root, ".xharness"));
  await writeFile(
    join(root, ".xharness", "config.yaml"),
    "main: {model: claude:sonnet, effort: low}\n",
  );
  const provider: Provider = {
    id: "claude",
    models: () => [
      { id: "claude-opus-5-5", contextTokens: 1000000 },
      { id: "claude-sonnet-5-5", contextTokens: 1000000 },
    ],
    async *stream() {
      throw new Error("No network expected");
    },
  };
  for (const cli of [false, true]) {
    const c = new SessionController({
      home,
      provider,
      model: "claude-opus-5-5",
      effort: "high",
      phase4: true,
      fake: false,
      version: "test",
      host: { pickFolder: async () => root },
      emit: () => {},
      ...(cli ? { cliModel: "opus", cliEffort: "high" as const } : {}),
    });
    await c.init();
    const ws = await c.handle({ type: "pick_folder" });
    if (!ws.ok || !ws.workspaceId) throw new Error("workspace failed");
    const created = await c.handle({
      type: "new_session",
      workspaceId: ws.workspaceId,
    });
    if (!created.ok) throw new Error("session failed");
    const session = (await c.state()).sessions.find(
      (s) => s.id === created.sessionId,
    );
    expect(session?.model).toBe(cli ? "claude-opus-5-5" : "claude-sonnet-5-5");
    expect(session?.effort).toBe(cli ? "high" : "low");
    await c.shutdown();
  }
});
it("blocks simultaneous writers to one workspace and rejects fake repository network operations", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-writers-"));
  const root = await mkdtemp(join(tmpdir(), "xh-writers-root-"));
  let started = false;
  const provider: Provider = {
    id: "claude",
    models: () => [{ id: "fake", contextTokens: 1000000 }],
    async *stream(_request, signal) {
      started = true;
      await new Promise<void>((r) =>
        signal.addEventListener("abort", () => r(), { once: true }),
      );
    },
  };
  const c = new SessionController({
    home,
    provider,
    model: "fake",
    phase4: true,
    fake: true,
    version: "test",
    host: { pickFolder: async () => root },
    emit: () => {},
    createTools: () => new Map(),
  });
  await c.init();
  const ws = await c.handle({ type: "pick_folder" });
  if (!ws.ok || !ws.workspaceId) throw new Error("workspace failed");
  const a = await c.handle({
      type: "new_session",
      workspaceId: ws.workspaceId,
    }),
    b = await c.handle({ type: "new_session", workspaceId: ws.workspaceId });
  if (!a.ok || !b.ok || !a.sessionId || !b.sessionId)
    throw new Error("session failed");
  await c.handle({ type: "send", sessionId: a.sessionId, text: "hold" });
  await until(() => started);
  expect(
    await c.handle({ type: "send", sessionId: b.sessionId, text: "second" }),
  ).toEqual({ ok: false, error: "Workspace writer busy" });
  expect(
    (
      await c.handle({
        type: "open_repository",
        url: "https://example.com/a/b.git",
      })
    ).ok,
  ).toBe(false);
  await c.shutdown();
  const store = new SessionStore(home);
  await store.load();
  expect(store.list()).toHaveLength(2);
});
it("persists an always grant, reopens receipts with masked details, and keeps session-only mode changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-phase4-"));
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    id: "claude",
    models: () => [{ id: "fake", contextTokens: 1000000 }],
    async *stream(request) {
      requests.push(request);
      const hasResult = request.messages
        .at(-1)
        ?.content.some((b) => b.type === "tool_result");
      yield {
        type: "message_done",
        stopReason: hasResult ? "end_turn" : "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
        message: {
          role: "assistant",
          content: hasResult
            ? [{ type: "text", text: "done" }]
            : [
                {
                  type: "tool_use",
                  id: `call-${requests.length}`,
                  name: "Bash",
                  input: { command: "git status", extra: "private-token" },
                },
              ],
        },
      };
    },
  };
  const tool: Tool = {
    spec: { name: "Bash", description: "test", inputSchema: {} },
    readOnly: false,
    validate: async () => undefined,
    execute: async () => ({ content: "private-token" }),
  };
  let events: UiEvent[] = [];
  const make = () =>
    new SessionController({
      provider,
      model: "fake",
      phase4: true,
      fake: true,
      version: "test",
      home,
      secrets: ["private-token"],
      host: { pickFolder: async () => undefined },
      createTools: () => new Map([["Bash", tool]]),
      emit: (e) => events.push(e),
    });
  const controller = make();
  await controller.init();
  const created = await controller.handle({
    type: "new_session",
    workspaceId: null,
  });
  if (!created.ok || !created.sessionId) throw new Error("create failed");
  const sessionId = created.sessionId;
  await controller.handle({ type: "send", sessionId, text: "inspect" });
  await until(() => events.some((e) => e.type === "permission_request"));
  const pending = events.find((e) => e.type === "permission_request");
  if (pending?.type !== "permission_request") throw new Error("no permission");
  await controller.handle({
    type: "permission_response",
    sessionId,
    requestId: pending.requestId,
    decision: "always",
  });
  await until(() =>
    events.some((e) => e.type === "turn" && e.status === "idle"),
  );
  await controller.shutdown();
  expect(await readFile(join(home, "config.yaml"), "utf8")).toContain("git *");
  expect(
    await readFile(join(home, `receipts/${sessionId}.jsonl`), "utf8"),
  ).not.toContain("private-token");
  events = [];
  const reopened = make();
  await reopened.init();
  await reopened.handle({ type: "open_session", sessionId });
  const restored = events.find((e) => e.type === "receipt_history");
  expect(
    restored?.type === "receipt_history" && restored.receipts.length,
  ).toBeGreaterThan(0);
  await reopened.handle({ type: "set_mode", sessionId, mode: "acceptEdits" });
  await reopened.handle({ type: "send", sessionId, text: "inspect again" });
  await until(() =>
    events.some((e) => e.type === "turn" && e.status === "idle"),
  );
  expect(events.some((e) => e.type === "permission_request")).toBe(false);
  await reopened.shutdown();
  const other = await reopened.handle({
    type: "new_session",
    workspaceId: null,
  });
  if (!other.ok) throw new Error("create failed");
  expect(
    (await reopened.state()).sessions.find((s) => s.id === other.sessionId)
      ?.permissionMode,
  ).toBe("default");
});
