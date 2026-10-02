import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  FakeProvider,
  type FakeStep,
} from "../providers/fake/fake-provider.js";
import { type ProviderRequest } from "../providers/provider.js";
import { Router } from "../core/router.js";
import { defaultTools } from "../session/controller.js";
import { loadAgentConfig } from "../agents/definitions.js";
import { WorkflowRuntime } from "./runtime.js";
import { runGit } from "../session/repository.js";
import { type PlanItem } from "./plan-validate.js";

const call = (name: string, input: unknown): FakeStep => ({
  type: "message",
  stopReason: "tool_use",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: `call-${name}`, name, input }],
  },
});
const text = (text: string): FakeStep => ({
  type: "message",
  stopReason: "end_turn",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
it("rejects the real malformed SubmitPlan while advertising the full item shape for recovery", async () => {
  const bad = JSON.parse(
    await readFile("test/fixtures/stabilize/malformed-plan.json", "utf8"),
  );
  const s = await setup([call("SubmitPlan", bad), text("stopped")], []);
  const result = await s.runtime.run(
    {
      provider: s.providers[0]!,
      model: "claude-opus-5-5",
      system: "test",
      messages: [
        { role: "user", content: [{ type: "text", text: "fix add" }] },
      ],
      tools: defaultTools(s.cwd, false),
      permission: async () => true,
      maxRounds: 2,
    },
    new AbortController().signal,
  );
  const schema = s.requests[0]!.tools.find((t) => t.name === "SubmitPlan")!
    .inputSchema as {
    properties: {
      items: {
        items: {
          properties: { assignee: { type: string; required: string[] } };
          required: string[];
        };
      };
    };
  };
  expect(schema.properties.items.items.properties.assignee.type).toBe("object");
  expect(schema.properties.items.items.required).toContain("instructions");
  const errors = result.messages
    .flatMap((m) => m.content)
    .filter((b) => b.type === "tool_result");
  expect(JSON.stringify(errors)).toContain("assignee");
  expect(s.runtime.state.phase).toBe("plan");
});
it("manual review reruns the reviewer without a main model call", async () => {
  const s = await setup([], []);
  const first = await s.run();
  expect(first.stopCause).toBe("end_turn");
  s.runtime.manualPhase("implement");
  const tools = defaultTools(s.cwd, false);
  await s.runtime.changes
    .wrap(tools)
    .get("Write")!
    .execute(
      { path: "manual.txt", content: "change" },
      new AbortController().signal,
    );
  const count = s.requests.length;
  s.runtime.manualPhase("review");
  const result = await s.run();
  expect(result.stopCause).toBe("workflow_complete");
  expect(s.requests.slice(count)).toHaveLength(1);
  expect(s.requests.at(-1)?.system).toMatch(/^You are reviewer/);
  expect(() => s.runtime.manualPhase("complete")).toThrow();
});
it("stops after three invalid real plans instead of spending the remaining request budget", async () => {
  const bad = JSON.parse(
    await readFile("test/fixtures/stabilize/malformed-plan.json", "utf8"),
  );
  const s = await setup(
    [
      call("SubmitPlan", bad),
      call("SubmitPlan", bad),
      call("SubmitPlan", bad),
      text("must not send"),
    ],
    [],
  );
  const result = await s.run();
  expect(result.stopCause).toBe("plan_validation_failed");
  expect(s.requests).toHaveLength(3);
  expect(s.runtime.state.phase).toBe("plan");
});
it("queues an in-flight phase change until the receipt is closed", async () => {
  const s = await setup([text("answer"), text("plan")], []);
  let queued = false;
  const result = await s.runtime.run(
    {
      provider: s.providers[0]!,
      model: "claude-opus-5-5",
      system: "test",
      messages: [],
      tools: defaultTools(s.cwd, false),
      permission: async () => true,
      maxRounds: 2,
      onEvent: (e) => {
        if (e.type === "step" && e.step === "model" && !queued) {
          s.runtime.queuePhase("plan");
          queued = true;
          expect(s.runtime.state.phase).toBe("classify");
        }
      },
    },
    new AbortController().signal,
  );
  expect(s.runtime.state.phase).toBe("plan");
  expect(s.requests).toHaveLength(2);
  expect(result.stopCause).toBe("round_limit");
});
const item = (id: string, dependsOn: string[] = []): PlanItem => ({
  id,
  title: id,
  instructions: `Write ${id}.txt with done`,
  files: [`${id}.txt`],
  dependsOn,
  assignee: {
    agent: "worker",
    model: "codex:sol",
    effort: "low",
    reason: "独立した実装",
  },
  acceptance: `${id}.txt is done`,
});
async function setup(claude: FakeStep[], codex: FakeStep[], git = false) {
  const home = await mkdtemp(join(tmpdir(), "xh-workflow-"));
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const requests: ProviderRequest[] = [];
  const providers = [
    new FakeProvider({ script: claude, onRequest: (r) => requests.push(r) }),
    new FakeProvider({
      provider: "codex",
      script: codex,
      onRequest: (r) => requests.push(r),
    }),
  ];
  const signal = new AbortController().signal;
  if (git) {
    await runGit(["init", "-b", "session"], cwd, signal);
    await writeFile(join(cwd, "seed.txt"), "seed");
    await runGit(["add", "."], cwd, signal);
    await runGit(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "initial",
      ],
      cwd,
      signal,
    );
  }
  const config = await loadAgentConfig(home);
  let approvals = 0;
  let checks = 0;
  const runtime = new WorkflowRuntime({
    home,
    cwd,
    parentId: "session1",
    config,
    router: new Router(providers),
    createTools: (cwd) => defaultTools(cwd, false),
    permission: async () => true,
    approve: async () => {
      approvals++;
      return true;
    },
    waveChecks: async () => {
      checks++;
      return { ok: true, output: "tests passed" };
    },
  });
  return {
    runtime,
    requests,
    config,
    home,
    cwd,
    providers,
    approvals: () => approvals,
    checks: () => checks,
    run: () =>
      runtime.run(
        {
          provider: providers[0]!,
          router: new Router(providers),
          model: "claude-opus-5-5",
          system: "Test",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "PARENT HISTORY - never give this to a child",
                },
              ],
            },
          ],
          tools: defaultTools(cwd, false),
          permission: async () => true,
          maxRounds: 15,
        },
        signal,
      ),
  };
}

it("Task uses a new session, returns only final text and excludes nested Task and writes", async () => {
  const s = await setup(
    [
      call("Task", {
        description: "Investigate",
        prompt: "CHILD ONLY",
        agent: "explorer",
      }),
      text("child answer"),
      text("main answer"),
    ],
    [],
  );
  const result = await s.run();
  expect(result.stopCause).toBe("end_turn");
  const child = s.requests.find((r) => r.system.includes("You are explorer"))!;
  expect(child.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "CHILD ONLY" }] },
  ]);
  expect(child.tools.map((t) => t.name)).not.toEqual(
    expect.arrayContaining(["Task", "Write", "Edit"]),
  );
  expect(child.sessionId).not.toBe("session1");
  const parentResult = result.messages
    .flatMap((m) => m.content)
    .find((b) => b.type === "tool_result");
  expect(parentResult).toMatchObject({ content: "child answer" });
  const saved = await readFile(
    join(s.home, "agents", "session1", "sessions", `${child.sessionId}.jsonl`),
    "utf8",
  );
  expect(saved).toContain("CHILD ONLY");
  expect(saved).not.toContain("PARENT HISTORY");
});
it("refuses Task worker and disabled models without sending to a child", async () => {
  const s = await setup(
    [
      call("Task", { description: "Bad", prompt: "do it", agent: "worker" }),
      call("Task", {
        description: "Bad",
        prompt: "do it",
        agent: "explorer",
        model: "claude:claude-fable-5-1",
      }),
      text("done"),
    ],
    [],
  );
  const result = await s.run();
  expect(
    s.requests.every((r) => !r.system.startsWith("You are explorer")),
  ).toBe(true);
  expect(
    result.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result" && b.isError),
  ).toHaveLength(2);
});
it("requires review even after a premature end_turn, then completes only after reviewer approval", async () => {
  const s = await setup(
    [
      call("SkipPlan", { reason: "One new file" }),
      call("Write", { path: "fix.txt", content: "fix" }),
      text("I'm done"),
      call("RequestReview", { summary: "Added fix" }),
    ],
    [text("[]")],
  );
  const result = await s.run();
  expect(result.stopCause).toBe("workflow_complete");
  expect(s.runtime.state.phase).toBe("complete");
  expect(
    s.requests.some(
      (r) => r.system.includes("You are reviewer") && r.model === "gpt-6.1-sol",
    ),
  ).toBe(true);
  expect(
    s.requests.filter((r) => !r.system.startsWith("You are reviewer")).at(-1)
      ?.messages,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        content: [
          expect.objectContaining({
            text: expect.stringContaining("RequestReview succeeds"),
          }),
        ],
      }),
    ]),
  );
});
it("returns must findings to implement and stops for user judgment at the configured limit", async () => {
  const finding = [{ severity: "must", file: "fix.txt", message: "Fix it" }];
  const s = await setup(
    [
      call("SkipPlan", { reason: "Small" }),
      call("Write", { path: "fix.txt", content: "fix" }),
      call("RequestReview", { summary: "First" }),
      call("RequestReview", { summary: "Still unchanged" }),
    ],
    [text(JSON.stringify(finding)), text(JSON.stringify(finding))],
  );
  const result = await s.run();
  expect(result.stopCause).toBe("review_attention");
  expect(s.runtime.state.reviewRound).toBe(2);
  expect(s.runtime.state.findings).toEqual(finding);
});
it("rejects invalid reviewer output and zero-change completion", async () => {
  const s = await setup(
    [
      call("SkipPlan", { reason: "Small" }),
      call("RequestReview", { summary: "No changes" }),
      call("Write", { path: "fix.txt", content: "fix" }),
      call("RequestReview", { summary: "Changed" }),
      call("RequestReview", { summary: "Retry review" }),
    ],
    [text("Trust me it is fine"), text("[]")],
  );
  const result = await s.run();
  expect(result.stopCause).toBe("workflow_complete");
  expect(
    result.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result" && b.isError),
  ).toHaveLength(2);
});
it("does not write during planning", async () => {
  const s = await setup(
    [
      call("Write", { path: "forbidden.txt", content: "bad" }),
      call("SkipPlan", { reason: "Small" }),
      call("Write", { path: "allowed.txt", content: "good" }),
      call("RequestReview", { summary: "Fix" }),
    ],
    [text("[]")],
  );
  await s.run();
  await expect(readFile(join(s.cwd, "forbidden.txt"))).rejects.toThrow();
  expect(await readFile(join(s.cwd, "allowed.txt"), "utf8")).toBe("good");
});
it("isolates workers in worktrees, merges and tests each item before its dependent starts", async () => {
  const s = await setup(
    [
      call("SubmitPlan", {
        items: [item("P1"), item("P2", ["P1"])],
        notes: "Two steps",
      }),
      call("RequestReview", { summary: "Both done" }),
      text("[]"),
    ],
    [
      call("Write", { path: "P1.txt", content: "done" }),
      call("ReportDone", {
        summary: "P1",
        changedFiles: ["P1.txt"],
        testsRun: ["checked P1"],
      }),
      call("Read", { path: "P1.txt" }),
      call("Write", { path: "P2.txt", content: "done" }),
      call("ReportDone", {
        summary: "P2",
        changedFiles: ["P2.txt"],
        testsRun: ["checked P2"],
      }),
    ],
    true,
  );
  const result = await s.run();
  expect(result.stopCause).toBe("workflow_complete");
  expect(s.approvals()).toBe(1);
  expect(s.checks()).toBe(2);
  expect(await readFile(join(s.cwd, "P1.txt"), "utf8")).toBe("done");
  expect(await readFile(join(s.cwd, "P2.txt"), "utf8")).toBe("done");
  const workers = s.requests.filter((r) =>
    r.system.startsWith("You are worker"),
  );
  expect(workers[0]?.system).toContain("session1-w1");
  expect(workers.at(-1)?.system).toContain("session1-w2");
  expect(
    workers.every(
      (r) => !JSON.stringify(r.messages).includes("PARENT HISTORY"),
    ),
  ).toBe(true);
  expect(
    s.requests.find((r) => r.system.startsWith("You are reviewer"))?.model,
  ).toBe("claude-sonnet-5-5");
}, 15000);
it("main assignments use the parent loop instead of a worker", async () => {
  const plan = item("P1");
  plan.assignee.agent = "main";
  plan.assignee.model = "claude:opus";
  const s = await setup(
    [
      call("SubmitPlan", { items: [plan], notes: "Main" }),
      call("Write", { path: "P1.txt", content: "done" }),
      call("UpdatePlan", { itemIndex: 0, status: "completed" }),
      call("RequestReview", { summary: "Main done" }),
    ],
    [text("[]")],
  );
  expect((await s.run()).stopCause).toBe("workflow_complete");
  expect(s.checks()).toBe(1);
  expect(s.requests.some((r) => r.system.startsWith("You are worker"))).toBe(
    false,
  );
});

it("main executes its assigned model and effort with parent history, without spawning a worker", async () => {
  const plan = item("P1");
  plan.assignee.agent = "main";
  const s = await setup(
    [
      call("SubmitPlan", { items: [plan], notes: "Main uses Sol low" }),
      call("RequestReview", { summary: "Main implemented" }),
      text("[]"),
    ],
    [
      call("Write", { path: "P1.txt", content: "done" }),
      call("UpdatePlan", { itemIndex: 0, status: "completed" }),
    ],
  );
  expect((await s.run()).stopCause).toBe("workflow_complete");
  const assigned = s.requests.find(
    (r) => r.model === "gpt-6.1-sol" && !r.system.startsWith("You are"),
  );
  expect(assigned?.reasoning?.effort).toBe("low");
  expect(JSON.stringify(assigned?.messages)).toContain("PARENT HISTORY");
  expect(s.requests.some((r) => r.system.startsWith("You are worker"))).toBe(
    false,
  );
  expect(
    s.requests.find((r) => r.system.startsWith("You are reviewer"))?.model,
  ).toBe("claude-sonnet-5-5");
});

it("stops a failed worker wave and never starts its dependent", async () => {
  const s = await setup(
    [
      call("SubmitPlan", {
        items: [item("P1"), item("P2", ["P1"])],
        notes: "Two",
      }),
      text("main must fix"),
    ],
    [text("I am done without ReportDone")],
    true,
  );
  await s.run();
  expect(s.runtime.state.phase).toBe("implement");
  expect(
    s.requests.filter((r) => r.system.startsWith("You are worker")),
  ).toHaveLength(1);
  await expect(readFile(join(s.cwd, "P2.txt"))).rejects.toThrow();
}, 15000);
it("keeps the integrated wave but holds dependencies when harness tests fail", async () => {
  const s = await setup(
    [
      call("SubmitPlan", {
        items: [item("P1"), item("P2", ["P1"])],
        notes: "Two",
      }),
      text("investigate"),
    ],
    [
      call("Write", { path: "P1.txt", content: "done" }),
      call("ReportDone", {
        summary: "P1",
        changedFiles: ["P1.txt"],
        testsRun: [],
      }),
    ],
    true,
  );
  const config = s.config;
  const runtime = new WorkflowRuntime({
    home: s.home,
    cwd: s.cwd,
    parentId: "test-failure",
    config,
    router: new Router(s.providers),
    createTools: (cwd) => defaultTools(cwd, false),
    permission: async () => true,
    approve: async () => true,
    waveChecks: async () => ({ ok: false, output: "Acceptance failed" }),
  });
  await runtime.run(
    {
      provider: s.providers[0]!,
      model: "claude-opus-5-5",
      system: "Test",
      tools: defaultTools(s.cwd, false),
      messages: [],
      permission: async () => true,
      maxRounds: 3,
    },
    new AbortController().signal,
  );
  expect(await readFile(join(s.cwd, "P1.txt"), "utf8")).toBe("done");
  expect(
    s.requests
      .filter((r) => r.system.startsWith("You are worker"))
      .every((r) => r.system.includes("w1")),
  ).toBe(true);
  expect(
    s.requests.filter((r) => r.system.startsWith("You are reviewer")),
  ).toHaveLength(0);
}, 15000);
it("does not commit protected secrets written by a worker", async () => {
  const s = await setup(
    [call("SubmitPlan", { items: [item("P1")], notes: "One" })],
    [
      call("Write", { path: "P1.txt", content: "dummy-private-value" }),
      call("ReportDone", {
        summary: "Done",
        changedFiles: ["P1.txt"],
        testsRun: [],
      }),
    ],
    true,
  );
  const runtime = new WorkflowRuntime({
    home: s.home,
    cwd: s.cwd,
    parentId: "secret-test",
    config: s.config,
    router: new Router(s.providers),
    createTools: (cwd) => defaultTools(cwd, false),
    permission: async () => true,
    approve: async () => true,
    redact: (s) => s.replaceAll("dummy-private-value", "[masked]"),
  });
  const result = await runtime.run(
    {
      provider: s.providers[0]!,
      model: "claude-opus-5-5",
      system: "Test",
      tools: defaultTools(s.cwd, false),
      messages: [],
      permission: async () => true,
      maxRounds: 1,
    },
    new AbortController().signal,
  );
  expect(result.stopCause).toBe("round_limit");
  await expect(readFile(join(s.cwd, "P1.txt"))).rejects.toThrow();
  expect(
    await runGit(
      ["rev-list", "--count", "HEAD"],
      s.cwd,
      new AbortController().signal,
    ),
  ).toBe("1");
}, 15000);

it("runs the built-in fake workflow demo end to end without a scripted provider", async () => {
  const s = await setup([], [], true);
  const result = await s.runtime.run(
    {
      provider: s.providers[0]!,
      model: "claude-opus-5-5",
      system: "Test",
      tools: defaultTools(s.cwd, false),
      messages: [
        { role: "user", content: [{ type: "text", text: "workflow-demo" }] },
      ],
      permission: async () => true,
      maxRounds: 10,
    },
    new AbortController().signal,
  );
  expect(result.stopCause).toBe("workflow_complete");
  expect(
    (await readFile(join(s.cwd, "phase5-demo.txt"), "utf8")).replaceAll(
      "\r\n",
      "\n",
    ),
  ).toBe("Fake workflow demo\n");
  expect(s.checks()).toBe(1);
}, 15000);

it("keeps nested folder work and its review inside that folder despite an ancestor Git repository", async () => {
  const s = await setup([], [], true);
  const cwd = join(s.cwd, "nested");
  await mkdir(cwd);
  await writeFile(
    join(s.cwd, "outside.txt"),
    "outside changes must not reach the folder reviewer",
  );
  const runtime = new WorkflowRuntime({
    home: s.home,
    cwd,
    parentId: "nested",
    config: s.config,
    router: new Router(s.providers),
    createTools: (cwd) => defaultTools(cwd, false),
    permission: async () => true,
    approve: async () => true,
  });
  const result = await runtime.run(
    {
      provider: s.providers[0]!,
      model: "claude-opus-5-5",
      system: "Test",
      tools: defaultTools(cwd, false),
      messages: [
        { role: "user", content: [{ type: "text", text: "workflow-demo" }] },
      ],
      permission: async () => true,
      maxRounds: 10,
    },
    new AbortController().signal,
  );
  expect(result.stopCause).toBe("workflow_complete");
  expect(await readFile(join(cwd, "phase5-demo.txt"), "utf8")).toContain(
    "Fake workflow demo",
  );
  const reviewer = s.requests.find((r) =>
    r.system.startsWith("You are reviewer"),
  );
  expect(JSON.stringify(reviewer?.messages)).not.toContain(
    "outside changes must not reach",
  );
  expect(
    await runGit(
      ["branch", "--list", "xh/nested-w*"],
      s.cwd,
      new AbortController().signal,
    ),
  ).toBe("");
});
it("keeps system and tools identical on every main request across phases (preserved thinking)", async () => {
  // Opus/Sonnet 5.5 は system と tools を過去の thinking の前提として検査し、変わると 400 になる
  const s = await setup(
    [
      call("Read", { path: "seed.txt" }),
      call("SkipPlan", { reason: "One new file" }),
      call("Write", { path: "fix.txt", content: "fix" }),
      call("RequestReview", { summary: "Added fix" }),
    ],
    [text("[]")],
  );
  await writeFile(join(s.cwd, "seed.txt"), "seed");
  const result = await s.run();
  expect(result.stopCause).toBe("workflow_complete");
  const main = s.requests.filter(
    (r) => !r.system.startsWith("You are reviewer"),
  );
  expect(main.length).toBeGreaterThanOrEqual(4);
  const first = main[0]!;
  for (const request of main) {
    expect(request.system).toBe(first.system);
    expect(request.tools).toEqual(first.tools);
  }
  // 段階の制限は validate で掛かる: 計画前の Write は実行されずエラーとして返る
  const names = first.tools.map((t) => t.name);
  for (const name of [
    "Write",
    "Edit",
    "SubmitPlan",
    "SkipPlan",
    "UpdatePlan",
    "RequestReview",
  ])
    expect(names).toContain(name);
});
it("gates phase-specific tools by validation instead of removing them", async () => {
  const s = await setup([], []);
  const tools = new Map<string, import("../tools/registry.js").Tool>();
  // classify では書き込みと実装段階のツールは使えない
  const registry = (
    s.runtime as unknown as {
      registry(
        base: Map<string, unknown>,
      ): Map<string, import("../tools/registry.js").Tool>;
    }
  ).registry(defaultTools(s.cwd, false));
  for (const [k, v] of registry) tools.set(k, v);
  expect(
    await tools.get("Write")!.validate({ path: "a", content: "b" }),
  ).toMatch(/unavailable/);
  expect(await tools.get("RequestReview")!.validate({ summary: "x" })).toMatch(
    /implement phase/,
  );
  expect(
    await tools
      .get("UpdatePlan")!
      .validate({ itemIndex: 0, status: "completed" }),
  ).toMatch(/implement phase/);
  expect(
    await tools.get("SkipPlan")!.validate({ reason: "small" }),
  ).toBeUndefined();
  s.runtime.manualPhase("implement");
  expect(
    await tools.get("Write")!.validate({ path: "a", content: "b" }),
  ).toBeUndefined();
  expect(await tools.get("SkipPlan")!.validate({ reason: "small" })).toMatch(
    /before implementation/,
  );
});
it("tells the reviewer the project's test command so it can rerun tests itself", async () => {
  const s = await setup(
    [
      call("SkipPlan", { reason: "One new file" }),
      call("Write", { path: "fix.txt", content: "fix" }),
      call("RequestReview", { summary: "Added fix" }),
    ],
    [text("[]")],
  );
  await writeFile(
    join(s.cwd, "package.json"),
    JSON.stringify({ scripts: { test: "node sum.test.js" } }),
  );
  await s.run();
  const reviewer = s.requests.find((r) =>
    r.system.startsWith("You are reviewer"),
  );
  expect(reviewer?.system).toContain("`npm test`");
  expect(reviewer?.system).toContain("do not use cd");
});
