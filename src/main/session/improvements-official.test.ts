import { expect, it } from "vitest";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./improvements.fixture.js";
import type { WorkflowRecord } from "../workflow/official/runtime.js";
import { sdkUsage } from "../workflow/official/usage.js";

async function setup(change?: (record: WorkflowRecord) => void) {
  const f = await fixture();
  const baseline = await f.baseline();
  const execute = f.requests.getMockImplementation()!;
  if (change)
    f.requests.mockImplementationOnce(async (request, signal) => {
      const result = await execute(request, signal);
      const path = join(
        f.home,
        "official-workflows",
        result.workflowId,
        "workflow.json",
      );
      const record = JSON.parse(await readFile(path, "utf8")) as WorkflowRecord;
      change(record);
      await writeFile(path, JSON.stringify(record));
      return result;
    });
  const evaluated = await f.evaluate(baseline, baseline.versions[0]!.id);
  const path = join(
    f.home,
    "official-workflows",
    evaluated.e.results[0]!.taskId,
    "workflow.json",
  );
  const record = JSON.parse(await readFile(path, "utf8")) as WorkflowRecord;
  return { ...f, ...evaluated, path, record };
}

it("records the exact official workflow, keeps missing usage unknown and never reruns the model while comparing", async () => {
  const f = await setup();
  expect(f.e.results[0]!.taskId).toBe(f.record.id);
  expect(f.view.rows[0]).toMatchObject({
    valid: true,
    quality: true,
    input: null,
    output: null,
    resourceComparable: false,
  });
  const count = f.requests.mock.calls.length;
  await f.list();
  await f.c.shutdown();
  const restarted = f.create();
  await restarted.init();
  expect((await f.list(restarted)).rows[0]).toMatchObject({
    valid: true,
    quality: true,
    resourceComparable: false,
  });
  expect(f.requests).toHaveBeenCalledTimes(count);
});

it("preserves measured SDK tokens but marks simulated usage as reference", async () => {
  const f = await setup((record) => {
    const call = record.calls[0]!;
    if (call.status === "running") throw Error("fixture");
    call.usage = sdkUsage({
      modelUsage: {
        "claude-haiku-5-5": {
          inputTokens: 5,
          outputTokens: 3,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
        },
      },
    });
  });
  expect(f.view.rows[0]).toMatchObject({
    valid: true,
    quality: true,
    input: 8,
    output: 3,
    inputCoverage: "1/1",
    outputCoverage: "1/1",
    resourceComparable: false,
  });
  expect(f.view.rows[0]!.note).toContain("模擬");
});

it("does not sum cumulative thread usage as independent calls", async () => {
  const f = await setup((record) => {
    const call = record.calls[0]!;
    if (call.status === "running") throw Error("fixture");
    call.usage = {
      scope: "thread-cumulative",
      complete: true,
      byModel: [],
      measurement: {
        provider: "claude",
        raw: { input_tokens: 50, output_tokens: 7 },
      },
    };
  });
  expect(f.view.rows[0]).toMatchObject({
    valid: true,
    input: null,
    output: null,
    resourceComparable: false,
  });
});

it.each(["simulation", "dispatch", "usage-provider"] as const)(
  "rejects missing or inconsistent %s provenance before registering a result",
  async (kind) => {
    await expect(
      setup((record) => {
        const call = record.calls[0]!;
        if (call.status === "running") throw Error("fixture");
        if (kind === "simulation") Reflect.deleteProperty(record, "simulated");
        if (kind === "dispatch") Reflect.deleteProperty(call, "dispatched");
        if (kind === "usage-provider")
          call.usage = {
            scope: "main-loop",
            complete: true,
            byModel: [],
            measurement: {
              provider: "codex",
              raw: { input_tokens: 1, output_tokens: 1 },
            },
          };
      }),
    ).rejects.toThrow();
  },
);

it.each([
  "answer",
  "goal",
  "session",
  "unfinished",
  "pending",
  "usage",
  "receipt",
] as const)(
  "invalidates changed %s evidence without replaying or adopting",
  async (kind) => {
    const f = await setup();
    const count = f.requests.mock.calls.length;
    if (kind === "receipt") {
      await rm(join(f.home, "receipts", `${f.id}.jsonl`), {
        recursive: true,
        force: true,
      });
    } else {
      if (kind === "answer") f.record.answer = "changed final answer";
      if (kind === "goal") f.record.goal = "different task";
      if (kind === "session") f.record.sessionId = f.sessionId;
      if (kind === "unfinished") {
        f.record.status = "interrupted";
        delete f.record.finishedAt;
      }
      if (kind === "pending")
        f.record.pendingEffect = { kind: "test", id: "pending" };
      if (kind === "usage") {
        const call = f.record.calls[0]!;
        if (call.status === "running") throw Error("fixture");
        call.usage = sdkUsage({
          modelUsage: {
            "claude-haiku-5-5": {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          },
        });
      }
      await writeFile(f.path, JSON.stringify(f.record));
    }
    expect((await f.list()).rows[0]).toMatchObject({
      valid: false,
      quality: false,
      resourceComparable: false,
    });
    expect(
      await f.action({
        action: "adopt",
        id: f.e.id,
        revision: f.e.revision,
        versionId: f.e.versions[0]!.id,
        confirmed: true,
        reason: "changed evidence",
      }),
    ).toMatchObject({ ok: false });
    expect(f.requests).toHaveBeenCalledTimes(count);
  },
);
