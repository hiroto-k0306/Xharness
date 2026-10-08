import { expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { OfficialWorkflowService } from "./service.js";
import { testDependencies } from "./test-dependencies.js";
import { workflowGitEnvironment, workflowGitPolicyArgs } from "./workspace.js";

it("approves one Vitest task, copies existing dependencies after approval, tests and reviews without changing the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "xh-vitest-session-")),
    cwd = join(root, "project"),
    home = join(root, "home"),
    signal = new AbortController().signal;
  const services: OfficialWorkflowService[] = [];
  try {
    await mkdir(cwd);
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ type: "module", devDependencies: { vitest: "5.0.3" } }),
    );
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
    await writeFile(join(cwd, "add.mjs"), "export const add=(a,b)=>a-b;\n");
    await writeFile(
      join(cwd, "acceptance.test.ts"),
      "import {it,expect} from 'vitest';import {add} from './add.mjs';it('addition',()=>expect(add(2,3)).toBe(5));\n",
    );
    const exec = promisify(execFile),
      git = (args: string[]) =>
        exec("git", [...workflowGitPolicyArgs(), ...args], {
          cwd,
          windowsHide: true,
          env: workflowGitEnvironment(),
        });
    await git(["init"]);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@local",
      "commit",
      "-qm",
      "fixture: Vitest task",
    ]);
    const seed = await testDependencies(process.cwd(), ["vitest"], signal);
    await seed.materialize(cwd, signal);
    const before = await readFile(join(cwd, "add.mjs")),
      head = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const service = new OfficialWorkflowService({ home, fake: true });
    services.push(service);
    const done = service.submitSession(
      {
        sessionId: "vitest-session",
        cwd,
        model: "claude:opus",
        effort: "high",
        text: "auto-work: 加算を修正して",
        automaticWork: true,
        history: [],
      },
      signal,
    );
    await expect
      .poll(() => service.view().approval, { timeout: 60000 })
      .toBeTruthy();
    const pending = service.view(),
      record = pending.records[0]!.record,
      destination = record.project!.preparation!.destination;
    expect(record.project!.testSetup?.kind).toBe("vitest");
    expect(record.project!.testSetup?.dependencies.files).toBeGreaterThan(0);
    await expect(access(destination)).rejects.toThrow();
    await service.command({
      action: "approve",
      id: pending.approval!.id,
      digest: "0".repeat(64),
    });
    await expect(access(destination)).rejects.toThrow();
    await service.command({
      action: "approve",
      id: pending.approval!.id,
      digest: pending.approval!.digest,
    });
    const result = await done;
    expect(result.status).toBe("completed");
    const final = service.view().records[0]!.record;
    expect(final.checks.at(-1)?.tests[0]).toMatchObject({
      id: "project-vitest-test",
      passed: true,
      exitCode: 0,
    });
    expect(final.reviews.at(-1)?.findings).toEqual([]);
    expect(await readFile(join(cwd, "add.mjs"))).toEqual(before);
    expect((await git(["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    expect((await git(["status", "--porcelain"])).stdout).toBe("");
    await service.close();
    const restored = new OfficialWorkflowService({ home, fake: true });
    services.push(restored);
    const loaded = await restored.command({ action: "list" });
    expect(loaded.records[0]?.record.project?.testSetup).toEqual(
      final.project!.testSetup,
    );
    expect(loaded.records[0]?.record.cwd).toBe(destination);
    expect(loaded.records[0]?.resumeBlocked).toBeTruthy();
  } finally {
    for (const service of services) await service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
}, 180000);
