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
import { fixture } from "./improvements.fixture.js";
import { SessionStore } from "./store.js";
import { officialSessionSummary } from "../workflow/official/session-result.js";
import type { WorkflowRecord } from "../workflow/official/runtime.js";
import type { HandoffAction } from "../../shared/handoffs.js";

async function setup(work = false) {
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
      }
      await mkdir(join(f.home, "official-workflows", id), { recursive: true });
      await writeFile(path(), JSON.stringify(record));
      return {
        workflowId: id,
        status: record.status,
        summary: officialSessionSummary(record, work),
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

it.each([false, true])(
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
