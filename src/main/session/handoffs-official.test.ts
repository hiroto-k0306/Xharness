import { expect, it, vi } from "vitest";
import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture } from "./official-session.fixture.js";
import { SessionStore } from "./store.js";
import {
  communicationInput,
  communicationText,
} from "../workflow/official/communication.js";
import { officialSessionSummary } from "../workflow/official/session-result.js";
import {
  approvalDigest,
  type WorkflowRecord,
} from "../workflow/official/runtime.js";
import type { HandoffAction } from "../../shared/handoffs.js";

async function makeDagRecord(
  record: WorkflowRecord,
  source: string,
  home: string,
) {
  delete record.project;
  delete record.nativeValidation;
  delete record.inputIntent;
  record.sourceCwd = source;
  record.nativeWork = { validation: "independent-process", baseline: "files" };
  record.executionDigest = "f".repeat(64);
  const owned = join(
    home,
    "official-workflows",
    record.id,
    "parallel",
    "project-dag-synthetic",
  );
  record.cwd = join(owned, "integration");
  record.plan = {
    summary: "Synthetic two-company DAG",
    parallelization: {
      mode: "parallel",
      reason: "Independent synthetic files",
      maxParallel: 2,
    },
    validation: { testFiles: ["a.test.mjs"] },
    tasks: ["a", "b"].map((id, i) => ({
      id,
      title: id,
      instructions: "Synthetic task",
      files: [i ? "b.mjs" : "a.test.mjs"],
      dependsOn: [],
      acceptance: ["synthetic"],
      assignee: {
        provider: i ? "codex" : "claude",
        model: i ? "sol" : "opus",
        effort: null,
        reason: "Synthetic implementer",
      },
      reviewer: {
        provider: i ? "claude" : "codex",
        model: i ? "opus" : "sol",
        effort: null,
        reason: "Cross-company synthetic reviewer",
      },
    })),
  };
  record.approvedDigest = approvalDigest(record);
  record.calls = [];
  record.reviews = [];
  record.commits = [];
  const nodes = [];
  const tasks = [];
  for (const task of record.plan.tasks) {
    const cwd = join(owned, `task-${task.id}`);
    await mkdir(cwd, { recursive: true });
    const commit = (task.id === "a" ? "c" : "d").repeat(40);
    record.commits.push(commit);
    const child: WorkflowRecord = {
      ...structuredClone(record),
      id: randomUUID(),
      cwd,
      base: "e".repeat(64),
      head: "f".repeat(64),
      nativeWork: { validation: "agent-reported", baseline: "files" },
      nativeValidation: [],
      plan: { summary: record.plan.summary, tasks: [task] },
      calls: [],
      checks: [],
      reviews: [],
      commits: [],
      answer: "Synthetic node complete",
    };
    child.approvedDigest = approvalDigest(child);
    for (const [phase, provider] of [
      ["implement", task.assignee.provider],
      ["review", task.reviewer!.provider],
    ] as const)
      child.calls.push({
        requestId: randomUUID(),
        phase,
        provider,
        requestedModel: provider === "claude" ? "opus" : "sol",
        effort: null,
        status: "completed",
        dispatched: true,
        observedModels: [],
        usage: null,
        elapsedMs: 1,
      });
    child.reviews = [{ base: child.base, head: child.head, findings: [] }];
    child.calls.find((c) => c.phase === "review")!.communication = {
      ...communicationInput({ instruction: "synthetic node review" }),
      output: communicationText(child.reviews[0]),
    };
    record.calls.push(...child.calls.map((c) => ({ ...c, nodeId: task.id })));
    nodes.push({
      id: task.id,
      state: "completed" as const,
      cwd,
      base: "a".repeat(40),
      record: child,
    });
    tasks.push({
      id: task.id,
      cwd,
      files: task.files,
      dependencies: task.dependsOn,
      baseHead: "a".repeat(40),
      commit,
      status: "completed" as const,
    });
  }
  record.dag = {
    maxParallel: 2,
    phase: "complete",
    nodes,
    nativeConversationResume: false,
  };
  record.nativeDagWorkspace = {
    source,
    sourceBase: record.base,
    sourceBranch: "synthetic",
    approvalDigest: record.approvedDigest,
    ownedDirectory: owned,
    tasks,
    integration: { cwd: record.cwd, head: record.head, status: "completed" },
  };
  record.checks = [
    {
      head: record.head,
      tests: [
        {
          id: "native-dag-node-validation",
          exitCode: 0,
          passed: true,
          source: "process",
          elapsedMs: 1,
          output: JSON.stringify({
            mechanism: "official-command-exec",
            status: "passed",
            counts: {
              tests: 1,
              pass: 1,
              fail: 0,
              cancelled: 0,
              skipped: 0,
              todo: 0,
            },
            outputDigest: "a".repeat(64),
          }),
        },
      ],
    },
  ];
  for (const provider of ["claude", "codex"] as const) {
    const review = { base: record.base, head: record.head, findings: [] };
    record.reviews.push(review);
    record.calls.push({
      requestId: randomUUID(),
      phase: "review",
      provider,
      requestedModel: provider === "claude" ? "opus" : "sol",
      effort: null,
      status: "completed",
      dispatched: true,
      observedModels: [],
      usage: null,
      elapsedMs: 1,
      communication: {
        ...communicationInput({ instruction: "synthetic" }),
        output: communicationText(review),
      },
    });
  }
  record.answer =
    "Synthetic independently verified integration; user branch unchanged.";
  await mkdir(record.cwd, { recursive: true });
  await writeFile(
    join(owned, "manifest.json"),
    JSON.stringify(record.nativeDagWorkspace),
  );
}

async function setup(work: boolean | "native" | "dag" = false) {
  const id = randomUUID();
  let record: WorkflowRecord;
  const official = vi.fn(
    async (r: { sessionId: string; text: string; cwd: string }) => {
      record = {
        version: 1,
        simulated: true,
        id,
        sessionId: r.sessionId,
        goal: r.text,
        cwd: r.cwd,
        startedAt: new Date(Date.now() - 1000).toISOString(),
        finishedAt: new Date().toISOString(),
        status: "completed",
        next: "complete",
        base: "a".repeat(40),
        head: "b".repeat(40),
        correctionRounds: 0,
        calls: [
          {
            requestId: randomUUID(),
            phase: work ? "implement" : "conversation",
            provider: "claude",
            requestedModel: "claude-haiku-5-5",
            effort: "low",
            status: "completed",
            dispatched: true,
            observedModels: [],
            usage: null,
            elapsedMs: 1,
          },
        ],
        tools: [],
        commits: [],
        checks: [],
        reviews: [],
        ...(work
          ? {
              project: {
                source: r.cwd,
                sourceHead: "a".repeat(40),
                files: ["add.mjs"],
                testFile: "acceptance.test.mjs",
              },
              approvedDigest: "c".repeat(64),
            }
          : {
              inputIntent: "question" as const,
              answer: "safe answer\napi_key=private-value",
            }),
      };
      if (work) {
        record.checks = [
          {
            head: record.head,
            tests: [
              {
                id: "arithmetic",
                exitCode: 0,
                passed: true,
                source: "process",
                elapsedMs: 1,
                output: "ok",
              },
            ],
          },
        ];
        record.reviews = [
          { base: record.base, head: record.head, findings: [] },
        ];
        if (work === "native") {
          delete record.project;
          record.nativeWork = {
            validation: "agent-reported",
            baseline: "files",
          };
          record.nativeValidation = [];
          record.checks = [];
          record.answer =
            "変更しました。テスト実行報告なし。別会社レビュー完了。";
        }
      }
      if (work === "dag") await makeDagRecord(record, r.cwd, f.home);
      await mkdir(join(f.home, "official-workflows", id), { recursive: true });
      await writeFile(path(), JSON.stringify(record));
      return {
        workflowId: id,
        status: record.status,
        summary: officialSessionSummary(record, !!work),
      };
    },
  );
  const f = await fixture(undefined, {
    model: "claude:opus",
    officialSession: official,
  });
  const path = () => join(f.home, "official-workflows", id, "workflow.json");
  const made = await f.c.handle({
    type: "new_session",
    workspaceId: f.workspaceId,
  });
  if (!made.ok || !made.sessionId) throw Error("destination");
  const destination = made.sessionId;
  await f.c.handle({
    type: "send",
    sessionId: f.sessionId,
    text: "synthetic request",
  });
  await vi.waitFor(async () =>
    expect(
      (await f.c.state()).sessions.find((s) => s.id === f.sessionId)?.status,
    ).toBe("idle"),
  );
  const action = (request: HandoffAction, sessionId = f.sessionId, c = f.c) =>
    c.handle({ type: "handoffs", sessionId, request });
  const preview = () =>
    action({ action: "preview", destinationId: destination });
  const ticket = async () => {
    const result = await preview();
    if (!result.ok || !result.handoffs?.preview)
      throw Error(JSON.stringify(result));
    return result.handoffs.preview;
  };
  const edit = async (change: (r: WorkflowRecord) => void) => {
    change(record);
    await writeFile(path(), JSON.stringify(record));
  };
  return {
    ...f,
    id,
    destination,
    official,
    action,
    preview,
    ticket,
    edit,
    path,
  };
}

it.each([false, true, "native", "dag"] as const)(
  "delivers a persisted official %s result once without legacy trace, preserves destination and survives restart",
  async (work) => {
    const f = await setup(work),
      before = await f.c.state();
    const p = await f.ticket();
    expect(p).toMatchObject({ taskId: f.id });
    expect(p!.body).not.toContain("private-value");
    expect(
      (await f.action({ action: "confirm", previewId: p!.id, confirmed: true }))
        .ok,
    ).toBe(true);
    expect(
      (await f.action({ action: "confirm", previewId: p!.id, confirmed: true }))
        .ok,
    ).toBe(true);
    expect(
      (await f.c.state()).sessions.find((s) => s.id === f.destination),
    ).toEqual(before.sessions.find((s) => s.id === f.destination));
    await expect(
      readFile(join(f.home, "sessions", f.destination + ".jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await f.c.shutdown();
    const restarted = f.create();
    await restarted.init();
    expect(
      await f.action({ action: "list" }, f.destination, restarted),
    ).toMatchObject({ ok: true, handoffs: { records: [{ id: p!.id }] } });
    expect(
      JSON.parse(await readFile(join(f.home, "handoffs.json"), "utf8")),
    ).toHaveLength(1);
    expect(f.official).toHaveBeenCalledTimes(1);
    expect(f.requests).not.toHaveBeenCalled();
  },
);

it("accepts old official history only when its receipt, workflow and public answer agree", async () => {
  const f = await setup(),
    file = join(f.home, "sessions", f.sessionId + ".jsonl");
  const raw = await readFile(file, "utf8");
  await writeFile(
    file,
    raw
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        const m = JSON.parse(line);
        delete m.meta;
        return JSON.stringify(m);
      })
      .join("\n"),
  );
  expect((await f.preview()).ok).toBe(true);
  await f.edit((r) => {
    r.sessionId = "foreign";
  });
  expect((await f.preview()).ok).toBe(false);
});

it.each([
  "failed",
  "cancelled",
  "interrupted",
  "planning",
  "quota-paused",
  "attention",
] as const)(
  "rejects a %s record without falling back to old evidence",
  async (status) => {
    const f = await setup();
    await f.edit((r) => {
      r.status = status;
    });
    expect(await f.preview()).toMatchObject({
      ok: false,
      error: expect.stringContaining("公式workflow"),
    });
    await expect(readFile(join(f.home, "handoffs.json"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  },
);

it.each([
  "scope-required",
  "pending",
  "running-call",
  "missing-time",
  "failed-test",
  "missing-review",
])("rejects incomplete official evidence: %s", async (change) => {
  const f = await setup(true);
  await f.edit((r) => {
    if (change === "scope-required") r.inputIntent = "work";
    if (change === "pending") r.pendingEffect = { kind: "test", id: "pending" };
    if (change === "running-call") r.calls[0]!.status = "running";
    if (change === "missing-time") delete r.finishedAt;
    if (change === "failed-test") r.checks[0]!.tests[0]!.passed = false;
    if (change === "missing-review") r.reviews = [];
  });
  expect((await f.preview()).ok).toBe(false);
});

it("invalidates a confirmation when workflow evidence or final history changes", async () => {
  const f = await setup(),
    p = await f.ticket();
  await f.edit((r) => {
    if (r.calls[0]!.status !== "running") r.calls[0]!.elapsedMs = 2;
  });
  expect(
    (await f.action({ action: "confirm", previewId: p.id, confirmed: true }))
      .ok,
  ).toBe(false);
  const again = await f.ticket();
  await appendFile(
    join(f.home, "sessions", f.sessionId + ".jsonl"),
    '\n{"role":"user","content":[{"type":"text","text":"new request"}]}',
  );
  expect(
    (
      await f.action({
        action: "confirm",
        previewId: again.id,
        confirmed: true,
      })
    ).ok,
  ).toBe(false);
});

it("rejects missing, corrupt and redirected official records", async () => {
  const f = await setup(),
    original = await readFile(f.path(), "utf8");
  await writeFile(f.path(), "{torn");
  expect((await f.preview()).ok).toBe(false);
  await rm(f.path());
  expect((await f.preview()).ok).toBe(false);
  const other = join(f.home, "redirect");
  await mkdir(other);
  await writeFile(join(other, "workflow.json"), original);
  await rm(join(f.home, "official-workflows", f.id), { recursive: true });
  await symlink(
    other,
    join(f.home, "official-workflows", f.id),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect((await f.preview()).ok).toBe(false);
});

it("retains recovery and permission refusal for official results", async () => {
  const f = await setup();
  await f.c.handle({
    type: "set_mode",
    sessionId: f.destination,
    mode: "plan",
  });
  expect((await f.preview()).ok).toBe(false);
  await f.c.handle({
    type: "set_mode",
    sessionId: f.destination,
    mode: "default",
  });
  const store = new SessionStore(f.home);
  await store.load();
  await store.recordEvaluationTask(f.destination, "uncertain", false, false);
  expect((await f.preview()).ok).toBe(false);
  expect(f.official).toHaveBeenCalledTimes(1);
});

it.each([
  "missing-checks",
  "missing-workspace",
  "unapproved",
  "changed-plan",
  "pending",
  "unfinished-node",
  "wrong-source",
  "foreign-owned-path",
  "wrong-head",
  "missing-manifest",
  "manifest-mismatch",
  "missing-final-company",
  "unconfirmed-final-call",
  "raw-test-output",
  "failed-process",
  "node-missing-review",
  "node-review-mismatch",
  "node-missing-call",
  "truncated-final-output",
  "mismatched-final-output",
])("rejects incomplete native DAG evidence: %s", async (change) => {
  const f = await setup("dag");
  if (change === "missing-manifest") {
    const record = JSON.parse(
      await readFile(f.path(), "utf8"),
    ) as WorkflowRecord;
    await rm(join(record.nativeDagWorkspace!.ownedDirectory, "manifest.json"));
  }
  await f.edit((r) => {
    if (change === "missing-checks") r.checks = [];
    if (change === "missing-workspace") delete r.nativeDagWorkspace;
    if (change === "unapproved") r.approvedDigest = "0".repeat(64);
    if (change === "changed-plan") r.plan!.summary = "tampered after approval";
    if (change === "pending")
      r.pendingEffect = { kind: "test", id: "uncertain" };
    if (change === "unfinished-node") r.dag!.nodes[0]!.state = "running";
    if (change === "wrong-source") r.sourceCwd = join(f.home, "foreign");
    if (change === "foreign-owned-path")
      r.nativeDagWorkspace!.ownedDirectory = f.home;
    if (change === "wrong-head")
      r.nativeDagWorkspace!.integration!.head = "c".repeat(40);
    if (change === "manifest-mismatch")
      r.nativeDagWorkspace!.sourceBranch = "changed";
    if (change === "missing-final-company")
      r.calls = r.calls.filter(
        (c) => c.nodeId || c.phase !== "review" || c.provider !== "claude",
      );
    if (change === "unconfirmed-final-call") {
      const c = r.calls.findLast((c) => !c.nodeId && c.phase === "review")!;
      if (c.status !== "running") c.dispatched = false;
    }
    if (change === "raw-test-output")
      r.checks[0]!.tests[0]!.output =
        "# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n";
    if (change === "failed-process") r.checks[0]!.tests[0]!.exitCode = 1;
    if (change === "node-review-mismatch") {
      const node = r.dag!.nodes[0]!.record!;
      const childCall = node.calls.find((c) => c.phase === "review")!;
      childCall.communication!.output = communicationText({
        base: node.base,
        head: "d".repeat(64),
        findings: [],
      });
      r.calls.find(
        (c) => c.nodeId === "a" && c.phase === "review",
      )!.communication = structuredClone(childCall.communication);
    }
    if (change === "node-missing-review") r.dag!.nodes[0]!.record!.reviews = [];
    if (change === "truncated-final-output")
      r.calls.findLast(
        (c) => !c.nodeId && c.phase === "review",
      )!.communication!.output!.truncated = true;
    if (change === "mismatched-final-output")
      r.calls.findLast(
        (c) => !c.nodeId && c.phase === "review",
      )!.communication!.output = communicationText({
        base: r.base,
        head: "c".repeat(40),
        findings: [],
      });
    if (change === "node-missing-call")
      r.calls = r.calls.filter((c) => c.nodeId !== "a" || c.phase !== "review");
  });
  expect((await f.preview()).ok).toBe(false);
});

it("accepts same-company implementation DAG with its opposite-company integration review", async () => {
  const f = await setup("dag");
  await f.edit((r) => {
    const task = r.plan!.tasks[1]!;
    task.assignee = { ...task.assignee, provider: "claude", model: "opus" };
    task.reviewer = { ...task.reviewer!, provider: "codex", model: "sol" };
    const child = r.dag!.nodes[1]!.record!;
    child.plan!.tasks = [structuredClone(task)];
    child.approvedDigest = approvalDigest(child);
    for (const call of child.calls) {
      call.provider = call.phase === "implement" ? "claude" : "codex";
      call.requestedModel = call.provider === "claude" ? "opus" : "sol";
    }
    r.calls = [
      ...r.calls.filter(
        (c) =>
          c.nodeId !== "b" &&
          (c.nodeId || c.phase !== "review" || c.provider !== "claude"),
      ),
      ...child.calls.map((c) => ({ ...c, nodeId: "b" })),
    ];
    r.approvedDigest = approvalDigest(r);
    r.nativeDagWorkspace!.approvalDigest = r.approvedDigest;
  });
  const record = JSON.parse(await readFile(f.path(), "utf8")) as WorkflowRecord;
  await writeFile(
    join(record.nativeDagWorkspace!.ownedDirectory, "manifest.json"),
    JSON.stringify(record.nativeDagWorkspace),
  );
  expect((await f.preview()).ok).toBe(true);
});
