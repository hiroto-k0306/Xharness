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
  "native work starts after plan approval in the selected folder (Git=%s)",
  async (git) => {
    const f = await fixture(git),
      abort = new AbortController(),
      before = await readFile(join(f.cwd, "add.mjs"));
    const done = f.service.submitSession(f.request, abort.signal);
    await expect
      .poll(() => f.service.view().approval, { timeout: 20000 })
      .toBeTruthy();
    const view = f.service.view(),
      record = view.records[0]!.record;
    expect(record.calls.map((c) => c.phase)).toEqual(["conversation", "plan"]);
    expect(record.nativeWork?.validation).toBe("agent-reported");
    expect(record.project).toBeUndefined();
    expect(record.cwd).toBe(f.cwd);
    expect(await readFile(join(f.cwd, "add.mjs"))).toEqual(before);
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
    expect(await readFile(join(f.cwd, "add.mjs"), "utf8")).toContain("a+b");
    const final = f.service.view().records[0]!.record;
    expect(final.checks).toEqual([]);
    expect(final.reviews.at(-1)?.findings).toEqual([]);
    expect(final.calls.length).toBeLessThanOrEqual(9);
    if (!git) await expect(access(join(f.cwd, ".git"))).rejects.toThrow();
    await f.service.close();
    const restored = new OfficialWorkflowService({
      home: join(f.cwd, "../home"),
      fake: true,
    });
    services.push(restored);
    const loaded = await restored.command({ action: "list" });
    expect(loaded.records[0]?.record).toMatchObject({
      id: final.id,
      status: "completed",
      cwd: f.cwd,
    });
    expect(loaded.records[0]?.resumeBlocked).toBeTruthy();
    expect(loaded.activeId).toBeUndefined();
  },
);
it("does not require existing tests, while read-only work remains blocked", async () => {
  const f = await fixture();
  await rm(join(f.cwd, "acceptance.test.mjs"));
  const missing = f.service.submitSession(
    f.request,
    new AbortController().signal,
  );
  await expect.poll(() => f.service.view().approval).toBeTruthy();
  const approval = f.service.view().approval!;
  await f.service.command({
    action: "approve",
    id: approval.id,
    digest: approval.digest,
  });
  expect((await missing).status).toBe("completed");
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
  const approval = f.service.view().approval!;
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
  expect(f.service.view().records[0]!.record.calls.map((c) => c.phase)).toEqual(
    ["conversation", "plan"],
  );
});
