import { afterEach, expect, it } from "vitest";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { OfficialWorkflowService } from "./service.js";
import { workflowGitEnvironment, workflowGitPolicyArgs } from "./workspace.js";
const exec = promisify(execFile),
  roots: string[] = [],
  services: OfficialWorkflowService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.close();
  for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true, maxRetries: 5 });
});
async function fixture(git = false) {
  const root = await mkdtemp(join(tmpdir(), "xh-auto-session-"));
  roots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd);
  await writeFile(join(cwd, "add.mjs"), "export const add=(a,b)=>a-b;\n");
  await writeFile(
    join(cwd, "acceptance.test.mjs"),
    "import assert from 'node:assert/strict';import {add} from './add.mjs';assert.equal(add(2,3),5);\n",
  );
  if (git) {
    const run = (args: string[]) =>
      exec("git", [...workflowGitPolicyArgs(), ...args], {
        cwd,
        env: workflowGitEnvironment(),
        windowsHide: true,
      });
    await run(["init"]);
    await run(["add", "."]);
    await run([
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@local",
      "commit",
      "-m",
      "baseline",
    ]);
  }
  const service = new OfficialWorkflowService({
    home: join(root, "home"),
    fake: true,
  });
  services.push(service);
  const request = {
    sessionId: "auto-session",
    cwd,
    model: "claude:opus",
    effort: "high" as const,
    text: "auto-work: 加算を修正してください",
    history: [],
    automaticWork: true,
  };
  return { cwd, service, request };
}
it.each([false, true])(
  "automatically selects scope and runs in an approved isolated workspace (Git=%s)",
  async (git) => {
    const f = await fixture(git),
      abort = new AbortController(),
      before = await readFile(join(f.cwd, "add.mjs"));
    const done = f.service.submitSession(f.request, abort.signal);
    await expect
      .poll(() => f.service.view().approval, { timeout: 20000 })
      .toBeTruthy();
    const view = f.service.view(),
      record = view.records[0]!.record,
      prep = record.project!.preparation!;
    expect(record.calls.map((c) => c.phase)).toEqual([
      "conversation",
      "conversation",
      "plan",
    ]);
    expect(prep.kind).toBe(git ? "git-worktree" : "local-copy");
    expect(record.project?.files).toEqual(["add.mjs"]);
    expect(record.project?.testFile).toBe("acceptance.test.mjs");
    await expect(access(prep.destination)).rejects.toThrow();
    await f.service.command({
      action: "approve",
      id: view.approval!.id,
      digest: view.approval!.digest,
    });
    const result = await done;
    expect(result).toMatchObject({
      status: "completed",
      intent: "work",
      taskRequired: false,
    });
    expect(await readFile(join(f.cwd, "add.mjs"))).toEqual(before);
    expect(await readFile(join(prep.destination, "add.mjs"), "utf8")).toContain(
      "a+b",
    );
    const final = f.service.view().records[0]!.record;
    expect(final.checks.at(-1)?.tests.every((t) => t.passed)).toBe(true);
    expect(final.reviews.at(-1)?.findings).toEqual([]);
    expect(final.calls.length).toBeLessThanOrEqual(9);
    if (!git) await expect(access(join(f.cwd, ".git"))).rejects.toThrow();
  },
);
it("stops missing tests and read-only work without planning or creating a workspace", async () => {
  const f = await fixture();
  await rm(join(f.cwd, "acceptance.test.mjs"));
  const missing = await f.service.submitSession(
    f.request,
    new AbortController().signal,
  );
  expect(missing.status).toBe("failed");
  expect(missing.summary).toContain("既存のNodeテスト");
  expect(f.service.view().records[0]!.record.calls).toHaveLength(1);
  const readonly = await f.service.submitSession(
    { ...f.request, automaticWork: false },
    new AbortController().signal,
  );
  expect(readonly.status).toBe("failed");
  expect(readonly.summary).toContain("読み取り専用");
  await expect(access(join(f.cwd, ".xharness-workspaces"))).rejects.toThrow();
});
it("a changed source after plan display stops before creating or editing a workspace", async () => {
  const f = await fixture(),
    done = f.service.submitSession(f.request, new AbortController().signal);
  await expect
    .poll(() => f.service.view().approval, { timeout: 20000 })
    .toBeTruthy();
  const approval = f.service.view().approval!,
    target =
      f.service.view().records[0]!.record.project!.preparation!.destination;
  await writeFile(join(f.cwd, "add.mjs"), "user's newer edit\n");
  await f.service.command({
    action: "approve",
    id: approval.id,
    digest: approval.digest,
  });
  expect((await done).status).toBe("failed");
  expect(await readFile(join(f.cwd, "add.mjs"), "utf8")).toContain(
    "user's newer edit",
  );
  await expect(access(target)).rejects.toThrow();
});
