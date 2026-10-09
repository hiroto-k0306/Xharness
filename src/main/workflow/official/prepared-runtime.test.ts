import { afterEach, expect, it, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createSyntheticWorkspace,
  fixtureAgents,
  fixtureWorkflowOptions,
} from "./fixtures.js";
import {
  runOfficialSingleTask,
  resumeBlockReason,
  type WorkflowRecord,
} from "./runtime.js";
import { gitWorkspace } from "./workspace.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
});
async function source() {
  const cwd = await createSyntheticWorkspace();
  roots.push(cwd);
  return cwd;
}
it("prepares only after saved approval, then implements/tests/reviews in the prepared cwd", async () => {
  const cwd = await source(),
    fake = fixtureAgents(),
    saved: WorkflowRecord[] = [];
  const before = await readFile(join(cwd, "add.mjs"));
  const prepare = vi.fn(async () => {
    expect(saved.at(-1)?.approvedDigest).toBeTruthy();
    expect(saved.at(-1)?.pendingEffect?.kind).toBe("worktree");
    const next = await source(),
      workspace = gitWorkspace(next, (s) => s);
    return {
      cwd: next,
      workspace,
      head: (await workspace.inspect(new AbortController().signal)).head,
    };
  });
  const options = fixtureWorkflowOptions(cwd, {
    agents: fake.agents,
    save: async (r) => {
      saved.push(structuredClone(r));
    },
  });
  options.prepareWorkspace = prepare;
  const result = await runOfficialSingleTask(
    options,
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(fake.requests.find((r) => r.phase === "plan")?.cwd).toBe(cwd);
  expect(
    JSON.parse(fake.requests.find((r) => r.phase === "plan")!.prompt)
      .instruction,
  ).toContain("in Japanese for user approval");
  expect(
    fake.requests
      .filter((r) => r.phase !== "plan")
      .every((r) => r.cwd === result.cwd),
  ).toBe(true);
  expect(result.cwd).not.toBe(cwd);
  expect(await readFile(join(cwd, "add.mjs"))).toEqual(before);
  expect(result.pendingEffect).toBeUndefined();
});
it("does not prepare a rejected or cancelled plan", async () => {
  for (const cancelled of [false, true]) {
    const cwd = await source(),
      abort = new AbortController(),
      prepare = vi.fn();
    const options = fixtureWorkflowOptions(cwd, {
      approve: async () => {
        if (cancelled) abort.abort();
        return cancelled;
      },
    });
    options.prepareWorkspace = prepare;
    const record = await runOfficialSingleTask(options, abort.signal);
    expect(record.status).not.toBe("completed");
    expect(prepare).not.toHaveBeenCalled();
  }
});
it("keeps an uncertain preparation intent and never retries it", async () => {
  const cwd = await source(),
    prepare = vi.fn(async () => {
      throw Error("fixture partial creation");
    });
  const options = fixtureWorkflowOptions(cwd);
  options.prepareWorkspace = prepare;
  const record = await runOfficialSingleTask(
    options,
    new AbortController().signal,
  );
  expect(record.status).toBe("failed");
  expect(record.pendingEffect?.kind).toBe("worktree");
  expect(resumeBlockReason(record)).toBeTruthy();
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(record.calls.map((c) => c.phase)).toEqual(["plan"]);
});
