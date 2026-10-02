import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { SessionController } from "./controller.js";
import {
  FakeProvider,
  type FakeStep,
} from "../providers/fake/fake-provider.js";
import { type UiEvent } from "../../shared/ipc.js";
import { type ProviderRequest } from "../providers/provider.js";

const call = (name: string, input: unknown): FakeStep => ({
  type: "message",
  stopReason: "tool_use",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: name, name, input }],
  },
});
const text = (text: string): FakeStep => ({
  type: "message",
  stopReason: "end_turn",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
it.skipIf(process.platform !== "win32")(
  "shows the complete project hook list and reuses approval across turns",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "xh-hook-approval-")),
      cwd = join(home, "project");
    await mkdir(join(cwd, ".xharness"), { recursive: true });
    await writeFile(
      join(cwd, ".xharness", "config.yaml"),
      `hooks:\n  - id: first\n    step: model\n    timing: before\n    command: Write-Output ${"x".repeat(350)}\n  - id: last-hook-in-list\n    step: model\n    timing: after\n    command: Write-Output done\n`,
    );
    const events: UiEvent[] = [];
    const c = new SessionController({
      home,
      provider: new FakeProvider({ script: [text("one"), text("two")] }),
      model: "claude-opus-5-5",
      phase4: true,
      fake: true,
      version: "test",
      host: { pickFolder: async () => cwd },
      emit: (e) => events.push(e),
    });
    await c.init();
    const ws = await c.handle({ type: "pick_folder" });
    if (!ws.ok || !ws.workspaceId) throw new Error("no folder");
    const created = await c.handle({
      type: "new_session",
      workspaceId: ws.workspaceId,
    });
    if (!created.ok || !created.sessionId) throw new Error("no session");
    const id = created.sessionId;
    await c.handle({ type: "send", sessionId: id, text: "one" });
    await until(() =>
      events.some(
        (e) => e.type === "permission_request" && e.tool === "ProjectHooks",
      ),
    );
    const request = events.find((e) => e.type === "permission_request");
    if (request?.type !== "permission_request") throw new Error("no approval");
    expect(request.summary).toContain("last-hook-in-list");
    await c.handle({
      type: "permission_response",
      sessionId: id,
      requestId: request.requestId,
      decision: "allow",
    });
    await until(
      () =>
        events.filter((e) => e.type === "turn" && e.status === "idle")
          .length === 1,
      10000,
    );
    await c.handle({ type: "send", sessionId: id, text: "two" });
    await until(
      () =>
        events.filter((e) => e.type === "turn" && e.status === "idle")
          .length === 2,
      10000,
    );
    expect(
      events.filter(
        (e) => e.type === "permission_request" && e.tool === "ProjectHooks",
      ),
    ).toHaveLength(1);
    await c.shutdown();
  },
  30000,
);

it("model apply affects only its session; defaults affect only future sessions", async () => {
  const s = await setup([]);
  const next = await s.c.handle({ type: "new_session", workspaceId: null });
  if (!next.ok || !next.sessionId) throw new Error("create failed");
  expect(
    await s.c.handle({
      type: "set_model",
      sessionId: s.id,
      model: "codex:luna",
      effort: "low",
    }),
  ).toMatchObject({ ok: true });
  expect(
    await s.c.handle({
      type: "set_model",
      sessionId: s.id,
      model: "codex:luna",
      effort: "ultra" as "high",
    }),
  ).toMatchObject({ ok: false });
  expect(
    await s.c.handle({
      type: "set_model",
      sessionId: s.id,
      model: "claude:fable",
    }),
  ).toMatchObject({ ok: false });
  let state = await s.c.state();
  expect(state.sessions.find((x) => x.id === next.sessionId)?.model).toBe(
    "claude-opus-5-5",
  );
  expect(state.sessions.find((x) => x.id === s.id)?.model).toBe("gpt-6-luna");
  expect(
    await s.c.handle({
      type: "set_default_model",
      model: "claude-sonnet-5-5",
      effort: "max",
    }),
  ).toMatchObject({ ok: true });
  const third = await s.c.handle({ type: "new_session", workspaceId: null });
  state = await s.c.state();
  expect(state.sessions.find((x) => x.id === next.sessionId)?.model).toBe(
    "claude-opus-5-5",
  );
  expect(
    state.sessions.find((x) => third.ok && x.id === third.sessionId),
  ).toMatchObject({ model: "claude-sonnet-5-5", effort: "max" });
  expect(await readFile(join(s.home, "config.yaml"), "utf8")).toContain(
    "claude-sonnet-5-5",
  );
  await s.c.shutdown();
});
it("edited plans are revalidated and their selected model takes effect", async () => {
  const item = {
    id: "a",
    title: "A",
    instructions: "A",
    files: ["a.txt"],
    dependsOn: [],
    assignee: {
      agent: "main",
      model: "claude:opus",
      effort: "high",
      reason: "small",
    },
    acceptance: "A",
  };
  const s = await setup([
    call("SubmitPlan", { items: [item], notes: "Plan" }),
    call("Read", { path: "a.txt" }),
  ]);
  await s.c.handle({ type: "send", sessionId: s.id, text: "implement" });
  await until(() =>
    s.events.some(
      (e) => e.type === "permission_request" && e.tool === "SubmitPlan",
    ),
  );
  const request = s.events.find((e) => e.type === "permission_request");
  if (request?.type !== "permission_request") throw new Error("no plan");
  expect(request.plan).toHaveLength(1);
  const invalid = {
    ...item,
    assignee: { ...item.assignee, model: "claude:fable" },
  };
  expect(
    await s.c.handle({
      type: "plan_response",
      sessionId: s.id,
      requestId: request.requestId,
      items: [invalid],
    }),
  ).toMatchObject({ ok: false });
  expect(s.requests).toHaveLength(1);
  const edited = {
    ...item,
    assignee: { ...item.assignee, model: "claude:sonnet", effort: "low" },
  };
  expect(
    await s.c.handle({
      type: "plan_response",
      sessionId: s.id,
      requestId: request.requestId,
      items: [edited],
    }),
  ).toMatchObject({ ok: true });
  await until(() => s.requests.length >= 2);
  expect(s.requests[1]).toMatchObject({
    model: "claude-sonnet-5-5",
    reasoning: { effort: "low" },
  });
  await s.c.shutdown();
});
it.skipIf(process.platform !== "win32")(
  "child shell hook receipts are saved independently and shown in the parent",
  async () => {
    const s = await setup(
      [
        call("Task", {
          description: "Inspect",
          agent: "reviewer",
          model: "claude:sonnet",
          prompt: "Inspect only",
        }),
        text("inspection"),
        text("done"),
      ],
      "hooks:\n  - id: child-check\n    step: model\n    timing: before\n    when: {agents: [reviewer]}\n    command: Write-Output hook-ok\n",
    );
    await s.c.handle({ type: "send", sessionId: s.id, text: "inspect" });
    await until(() =>
      s.events.some((e) => e.type === "turn" && e.status === "idle"),
    );
    const receipt = s.events.find(
      (e) => e.type === "receipt" && e.receipt.tool === "child-check",
    );
    if (receipt?.type !== "receipt" || !receipt.receipt.agentId)
      throw new Error("missing child hook receipt");
    expect(receipt.receipt).toMatchObject({
      provider: "hook",
      kind: "hook",
      output: expect.stringContaining("hook-ok"),
    });
    expect(
      await readFile(
        join(
          s.home,
          "agents",
          s.id,
          "receipts",
          receipt.receipt.agentId + ".jsonl",
        ),
        "utf8",
      ),
    ).toContain("child-check");
    expect(s.events.some((e) => e.type === "agent_transcript")).toBe(true);
    await s.c.shutdown();
  },
);
it("shows a question as a normal notice and resumes only after the user's reply", async () => {
  const s = await setup(
    [
      call("AskUserQuestion", {
        question: "案Aと案B、どちらですか？",
        options: ["案A", "案B"],
      }),
      text("案Aで再開します"),
    ],
    "workflow: {mode: off}\n",
  );
  await s.c.handle({ type: "send", sessionId: s.id, text: "作業して" });
  await until(() =>
    s.events.some((e) => e.type === "turn" && e.status === "idle"),
  );
  expect(s.events.findLast((e) => e.type === "turn")).toMatchObject({
    stopCause: "awaiting_user",
  });
  expect(
    s.events.some((e) => e.type === "notice" && e.message.includes("返答待ち")),
  ).toBe(true);
  expect(s.events.some((e) => e.type === "error")).toBe(false);
  expect(s.requests).toHaveLength(1);
  await s.c.handle({ type: "send", sessionId: s.id, text: "案A" });
  await until(
    () =>
      s.events.filter((e) => e.type === "turn" && e.status === "idle")
        .length === 2,
  );
  expect(s.requests).toHaveLength(2);
  expect(JSON.stringify(s.requests[1]!.messages)).toContain("案Aと案B");
  expect(s.requests[1]!.messages.at(-1)?.content).toEqual([
    { type: "text", text: "案A" },
  ]);
  await s.c.shutdown();
});
async function until(check: () => boolean, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function setup(
  script: FakeStep[],
  project = "",
  codexScript: FakeStep[] = [],
) {
  const home = await mkdtemp(join(tmpdir(), "xh-child-close-"));
  if (project) await writeFile(join(home, "config.yaml"), project);
  const requests: ProviderRequest[] = [];
  const events: UiEvent[] = [];
  const provider = new FakeProvider({
    script,
    onRequest: (r) => requests.push(r),
  });
  const c = new SessionController({
    home,
    provider,
    providers: [
      provider,
      new FakeProvider({
        provider: "codex",
        script: codexScript,
        onRequest: (r) => requests.push(r),
      }),
    ],
    model: "claude-opus-5-5",
    phase4: true,
    fake: true,
    version: "test",
    host: { pickFolder: async () => undefined },
    emit: (event) => events.push(event),
  });
  await c.init();
  const created = await c.handle({ type: "new_session", workspaceId: null });
  if (!created.ok || !created.sessionId) throw new Error("create failed");
  return { c, home, requests, events, id: created.sessionId };
}
it.each(["close", "shutdown", "abort"])(
  "%s cancels a child permission wait and stores its interrupted history",
  async (action) => {
    const s = await setup([
      call("Task", {
        description: "Test",
        agent: "reviewer",
        model: "claude:sonnet",
        prompt: "Test only",
      }),
      call("Bash", { command: "pnpm test" }),
      text("unused"),
    ]);
    await s.c.handle({ type: "send", sessionId: s.id, text: "review please" });
    await until(() =>
      s.events.some(
        (e) => e.type === "permission_request" && e.tool === "Bash",
      ),
    );
    if (action === "shutdown") await s.c.shutdown();
    else
      await s.c.handle({
        type: action === "close" ? "close_session" : "abort",
        sessionId: s.id,
      });
    await until(() =>
      s.events.some((e) => e.type === "turn" && e.status === "idle"),
    );
    expect(s.events.findLast((e) => e.type === "turn")).toMatchObject({
      stopCause: "aborted",
    });
    expect(
      s.events.filter((e) => e.type === "permission_resolved"),
    ).toHaveLength(1);
    expect(s.events.filter((e) => e.type === "agent").at(-1)).toMatchObject({
      status: "stopped",
    });
    const childId = s.requests.find((r) =>
      r.system.startsWith("You are reviewer"),
    )?.sessionId;
    const history = await readFile(
      join(s.home, "agents", s.id, "sessions", `${childId}.jsonl`),
      "utf8",
    );
    expect(history).toContain('"tool_result"');
    expect(history).not.toContain("review please");
    await s.c.shutdown();
  },
);
it("requires explicit plan approval even when a permission rule broadly allows tools", async () => {
  const item = {
    id: "P1",
    title: "One",
    instructions: "One",
    files: ["one.txt"],
    dependsOn: [],
    assignee: {
      agent: "main",
      model: "claude:opus",
      effort: "high",
      reason: "Small",
    },
    acceptance: "One",
  };
  const s = await setup(
    [
      call("SubmitPlan", { items: [item], notes: "Review this plan" }),
      text("unused"),
    ],
    'permissions:\n  rules: [{tool: "*", decision: allow}]\n',
  );
  await s.c.handle({ type: "send", sessionId: s.id, text: "implement please" });
  await until(() =>
    s.events.some(
      (e) => e.type === "permission_request" && e.tool === "SubmitPlan",
    ),
  );
  const request = s.events.find((e) => e.type === "permission_request");
  if (request?.type !== "permission_request")
    throw new Error("missing approval");
  expect(request.summary).toContain("Review this plan");
  await s.c.handle({
    type: "permission_response",
    sessionId: s.id,
    requestId: request.requestId,
    decision: "deny",
  });
  await until(() =>
    s.events.some((e) => e.type === "turn" && e.status === "idle"),
  );
  expect(s.events.findLast((e) => e.type === "turn")).toMatchObject({
    stopCause: "plan_rejected",
  });
  expect(s.requests).toHaveLength(1);
  await s.c.shutdown();
});
it("queues two reviewers' permission prompts and shutdown resolves the queue", async () => {
  const item = (
    id: string,
    agent: "main" | "worker",
    model: string,
    dependsOn: string[],
  ) => ({
    id,
    title: id,
    instructions: `Write ${id}.txt`,
    files: [`${id}.txt`],
    dependsOn,
    assignee: { agent, model, effort: "high", reason: "Test" },
    acceptance: "File exists",
  });
  const s = await setup(
    [
      call("SubmitPlan", {
        items: [
          item("P1", "worker", "codex:sol", []),
          item("P2", "main", "claude:opus", ["P1"]),
        ],
        notes: "Mixed providers",
      }),
      call("Write", { path: "P2.txt", content: "main" }),
      call("UpdatePlan", { itemIndex: 1, status: "completed" }),
      call("RequestReview", { summary: "Both providers implemented" }),
      call("Bash", { command: "pnpm test" }),
    ],
    "workflow: {worktrees: false}\n",
    [
      call("Write", { path: "P1.txt", content: "worker" }),
      call("ReportDone", {
        summary: "Worker done",
        changedFiles: ["P1.txt"],
        testsRun: [],
      }),
      call("Bash", { command: "pnpm test" }),
    ],
  );
  await s.c.handle({ type: "send", sessionId: s.id, text: "implement" });
  await until(() =>
    s.events.some(
      (e) => e.type === "permission_request" && e.tool === "SubmitPlan",
    ),
  );
  const approval = s.events.find((e) => e.type === "permission_request");
  if (approval?.type !== "permission_request")
    throw new Error("missing approval");
  await s.c.handle({
    type: "permission_response",
    sessionId: s.id,
    requestId: approval.requestId,
    decision: "allow",
  });
  await until(
    () =>
      s.requests.filter((r) => r.system.startsWith("You are reviewer"))
        .length === 2 &&
      s.events.some(
        (e) => e.type === "permission_request" && e.tool === "Bash",
      ),
  );
  expect(
    s.events.filter(
      (e) => e.type === "permission_request" && e.tool === "Bash",
    ),
  ).toHaveLength(1);
  await s.c.shutdown();
  const resolved = s.events.filter((e) => e.type === "permission_resolved");
  expect(resolved).toHaveLength(2);
  expect(resolved[1]).toMatchObject({ decision: "deny" });
  expect(
    s.events.filter(
      (e) =>
        e.type === "agent" && e.name === "reviewer" && e.status === "stopped",
    ),
  ).toHaveLength(2);
});
