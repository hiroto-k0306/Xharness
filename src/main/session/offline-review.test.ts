// Regression fixtures are isolated and use only fake providers/local Git.
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Message } from "../core/types.js";
import { type Provider } from "../providers/provider.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { WorkspaceTrust } from "../config/trust.js";
import { decidePermission } from "../core/permissions.js";
import { reserveLlmCall } from "../core/llm-budget.js";
import { type UiEvent } from "../../shared/ipc.js";
import { SessionController } from "./controller.js";
import { SessionStore } from "./store.js";
import { readLlmCalls, withSessionCalls } from "./llm-calls.js";
import { Repository, runGit } from "./repository.js";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Offline regression forbids fetch");
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const answer: Message = {
  role: "assistant",
  content: [{ type: "text", text: "offline answer" }],
};
async function setup(provider: Provider, model = "fake", workspace?: string) {
  const home = await mkdtemp(join(tmpdir(), "xh-review-test-"));
  const events: UiEvent[] = [];
  const controller = new SessionController({
    provider,
    model,
    home,
    fake: true,
    version: "test",
    host: { pickFolder: async () => workspace },
    createTools: () => new Map(),
    emit: (e) => events.push(e),
  });
  await controller.init();
  const picked = workspace
    ? await controller.handle({ type: "pick_folder" })
    : undefined;
  const created = await controller.handle({
    type: "new_session",
    workspaceId: picked?.ok ? (picked.workspaceId ?? null) : null,
  });
  if (!created.ok || !created.sessionId)
    throw new Error("fixture session failed");
  return { controller, home, events, sessionId: created.sessionId };
}

it.each(["abort", "close_session", "shutdown"] as const)(
  "cancels %s during send preparation before any provider request",
  async (action) => {
    const workspace = await mkdtemp(join(tmpdir(), "xh-review-ws-"));
    const onRequest = vi.fn();
    const c = await setup(
      new FakeProvider({
        script: [{ type: "message", message: answer, stopReason: "end_turn" }],
        onRequest,
      }),
      "fake",
      workspace,
    );
    const entered = deferred<void>();
    const release = deferred<boolean>();
    vi.spyOn(WorkspaceTrust.prototype, "isTrusted").mockImplementationOnce(
      () => {
        entered.resolve();
        return release.promise;
      },
    );
    const send = c.controller.handle({
      type: "send",
      sessionId: c.sessionId,
      text: "offline test",
    });
    await entered.promise;
    expect(c.events).toContainEqual({
      type: "turn",
      sessionId: c.sessionId,
      status: "running",
    });
    const stopped =
      action === "shutdown"
        ? c.controller.shutdown()
        : c.controller.handle({ type: action, sessionId: c.sessionId });
    release.resolve(true);
    expect(await send).toMatchObject({
      ok: false,
      error: "送信を中断しました。",
    });
    await stopped;
    expect(onRequest).not.toHaveBeenCalled();
    expect(c.events).toContainEqual({
      type: "turn",
      sessionId: c.sessionId,
      status: "idle",
      stopCause: "aborted",
    });
    expect((await c.controller.state()).sessions[0]?.status).toBe("idle");
    expect((await readLlmCalls(c.home, c.sessionId)).session).toBe(0);
    await c.controller.shutdown();
  },
);

it("rejects overlapping compact and send, and preserves the session cap after restart", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  const provider: Provider = {
    id: "codex",
    models: () => [{ id: "gpt-6-luna", contextTokens: 272000 }],
    async *stream(_request, signal) {
      reserveLlmCall(signal, true);
      calls++;
      entered.resolve();
      await release.promise;
      yield {
        type: "message_done",
        message: answer,
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
  const c = await setup(provider, "gpt-6-luna");
  await writeFile(
    join(c.home, "config.yaml"),
    "limits: {llmCallsPerTurn: 1, llmCallsPerSession: 1}\n",
  );
  const messages: Message[] = Array.from({ length: 4 }, (_, i) => [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "turn " + i }],
    },
    answer,
  ]).flat();
  await new SessionStore(c.home).append(c.sessionId, messages, (s) => s);
  await c.controller.handle({ type: "close_session", sessionId: c.sessionId });
  await c.controller.handle({ type: "open_session", sessionId: c.sessionId });
  const first = c.controller.handle({
    type: "send",
    sessionId: c.sessionId,
    text: "/compact",
  });
  const second = c.controller.handle({
    type: "send",
    sessionId: c.sessionId,
    text: "/compact",
  });
  await entered.promise;
  expect(await second).toMatchObject({
    ok: false,
    error: "Turn already running",
  });
  expect(
    await c.controller.handle({
      type: "send",
      sessionId: c.sessionId,
      text: "normal",
    }),
  ).toMatchObject({ ok: false });
  release.resolve();
  expect(await first).toEqual({ ok: true });
  expect(calls).toBe(1);
  expect((await readLlmCalls(c.home, c.sessionId)).session).toBe(1);
  await c.controller.shutdown();
  await new SessionStore(c.home).append(
    c.sessionId,
    messages.slice(0, 4),
    (s) => s,
  );
  const resumed = new SessionController({
    provider,
    model: "gpt-6-luna",
    home: c.home,
    fake: true,
    version: "test",
    host: { pickFolder: async () => undefined },
    createTools: () => new Map(),
    emit: () => {},
  });
  await resumed.init();
  expect(
    await resumed.handle({
      type: "send",
      sessionId: c.sessionId,
      text: "/compact",
    }),
  ).toMatchObject({ ok: false });
  expect(calls).toBe(1);
  await resumed.shutdown();
}, 15000); // Windows full-suite contention includes filesystem setup and reload.

it("rejects overlapping budget scopes even before their initial counter write", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-review-budget-"));
  const entered = deferred<void>();
  const release = deferred<void>();
  const options = {
    home,
    id: "test",
    limits: { llmCallsPerTurn: 1, llmCallsPerSession: 1 },
  };
  const first = withSessionCalls(
    { ...options, abort: new AbortController() },
    async (budget) => {
      reserveLlmCall(new AbortController().signal, true);
      entered.resolve();
      await release.promise;
      await budget.flush();
    },
  );
  await entered.promise;
  const second = vi.fn();
  await expect(
    withSessionCalls({ ...options, abort: new AbortController() }, second),
  ).rejects.toThrow("budget_busy");
  expect(second).not.toHaveBeenCalled();
  release.resolve();
  await first;
  expect((await readLlmCalls(home, "test")).session).toBe(1);
  await expect(
    withSessionCalls({ ...options, abort: new AbortController() }, async () =>
      reserveLlmCall(new AbortController().signal, true),
    ),
  ).rejects.toThrow("budget_exceeded");
});

it.each([
  "Get-Content mirror/credentials",
  "Get-Content -LiteralPath:mirror/credentials",
  "Get-Content safe.txt,mirror/credentials",
  "Get-ChildItem mirror/*",
])(
  "asks before plan Bash follows an outside secret junction: %s",
  async (command) => {
    const home = await mkdtemp(join(tmpdir(), "xh-review-link-"));
    const workspace = join(home, "workspace");
    const secret = join(home, ".aws");
    await mkdir(workspace);
    await mkdir(secret);
    await writeFile(join(secret, "credentials"), "SYNTHETIC_ONLY");
    await symlink(secret, join(workspace, "mirror"), "junction");
    expect(
      await decidePermission(
        { id: "test", name: "Bash", input: { command } },
        { mode: "plan", rules: [] },
        workspace,
      ),
    ).toBe("ask");
    expect(
      await decidePermission(
        {
          id: "test",
          name: "Bash",
          input: { command: "Get-Content safe.txt" },
        },
        { mode: "plan", rules: [] },
        workspace,
      ),
    ).toBe("allow");
  },
);

it("refuses wrong-branch, detached and dirty base merges, then merges the clean base", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-review-git-"));
  const root = join(home, "repo");
  await mkdir(root);
  const git: typeof runGit = (args, cwd, signal, progress) =>
    runGit(
      [
        "-c",
        "core.hooksPath=NUL",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Offline test",
        "-c",
        "user.email=offline@invalid.local",
        ...args,
      ],
      cwd,
      signal,
      progress,
    );
  const signal = new AbortController().signal;
  const repo = new Repository(home, git);
  await git(["init", "-b", "main"], root, signal);
  await writeFile(join(root, "base.txt"), "base");
  await git(["add", "base.txt"], root, signal);
  await git(["commit", "-m", "fixture base"], root, signal);
  const base = await git(["rev-parse", "HEAD"], root, signal);
  const tree = await repo.createWorktree(root, "ws", "test", signal);
  await writeFile(join(tree.path, "feature.txt"), "feature");
  await git(["add", "feature.txt"], tree.path, signal);
  await git(["commit", "-m", "fixture feature"], tree.path, signal);
  await git(["checkout", "-b", "unrelated"], root, signal);
  await expect(repo.finish(root, tree, "merge", true, signal)).rejects.toThrow(
    "branch changed",
  );
  expect(await git(["rev-parse", "HEAD"], root, signal)).toBe(base);
  await git(["checkout", "--detach"], root, signal);
  await expect(repo.finish(root, tree, "merge", true, signal)).rejects.toThrow(
    "branch changed",
  );
  await git(["checkout", "main"], root, signal);
  await writeFile(join(root, "base.txt"), "user changes");
  await expect(repo.finish(root, tree, "merge", true, signal)).rejects.toThrow(
    "uncommitted",
  );
  expect(await readFile(join(root, "base.txt"), "utf8")).toBe("user changes");
  await writeFile(join(root, "base.txt"), "base");
  await repo.finish(root, tree, "merge", true, signal);
  expect(await readFile(join(root, "feature.txt"), "utf8")).toBe("feature");
}, 30_000);
