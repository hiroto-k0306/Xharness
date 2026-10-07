import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  writeFile,
  stat,
  mkdir,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { expect, it } from "vitest";
import {
  createSyntheticWorkspace,
  fixtureAgents,
  fixtureWorkflowOptions,
} from "./fixtures.js";
import {
  prepareProjectTask,
  validateProjectScope,
  projectNode,
} from "./project-task.js";
import { OfficialWorkflowService } from "./service.js";
import { projectPreflight } from "./preflight.js";
import { runOfficialSingleTask } from "./runtime.js";
import { commandApproval } from "./command-approval.js";
const exec = promisify(execFile);
const signal = () => new AbortController().signal;
const scope = { files: ["add.mjs"], testFile: "acceptance.test.mjs" };

it("resolves an absolute host Node from PATH without accepting or executing a project node executable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xh-node-project-")),
    host = await mkdtemp(join(tmpdir(), "xh-node-host-")),
    name = process.platform === "win32" ? "node.exe" : "node";
  await writeFile(join(cwd, name), "untrusted project marker; never execute");
  await writeFile(join(host, name), "host lookup fixture; never execute");
  expect(await projectNode(cwd, [".", cwd, host].join(delimiter))).toBe(
    join(host, name),
  );
  await expect(projectNode(cwd, [".", cwd].join(delimiter))).rejects.toThrow(
    "trusted-host-node-executable-unavailable",
  );
  expect(await readFile(join(cwd, name), "utf8")).toBe(
    "untrusted project marker; never execute",
  );
});

it("stops a task before model dispatch if the actual session HEAD changes after preflight", async () => {
  const cwd = await createSyntheticWorkspace(),
    prepared = await prepareProjectTask(cwd, scope, signal()),
    fake = fixtureAgents();
  await writeFile(join(cwd, "user-note.txt"), "external change\n");
  await git(cwd, ["add", "--all"]);
  await git(cwd, [
    "-c",
    "user.name=Offline test",
    "-c",
    "user.email=offline@local",
    "commit",
    "-qm",
    "external change",
  ]);
  const after = await git(cwd, ["rev-parse", "HEAD"]);
  await expect(
    runOfficialSingleTask(
      fixtureWorkflowOptions(cwd, {
        agents: fake.agents,
        project: {
          source: cwd,
          sourceHead: prepared.sourceHead,
          files: scope.files,
          testFile: scope.testFile,
        },
      }),
      signal(),
    ),
  ).rejects.toThrow("session-head-changed-after-preflight");
  expect(fake.requests).toHaveLength(0);
  expect(await git(cwd, ["rev-parse", "HEAD"])).toBe(after);
  expect(await readFile(join(cwd, "user-note.txt"), "utf8")).toBe(
    "external change\n",
  );
});
async function git(cwd: string, args: string[]) {
  return (
    await exec(
      "git",
      [
        "-c",
        `safe.directory=${cwd}`,
        "-c",
        "core.hooksPath=/xharness-disabled-hooks",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd, windowsHide: true },
    )
  ).stdout.trim();
}
it("preflight uses the existing session directory and does not copy, mutate or run the test", async () => {
  const cwd = await createSyntheticWorkspace(),
    source = await readFile(join(cwd, "add.mjs"), "utf8"),
    config = await readFile(join(cwd, ".git/config"), "utf8"),
    index = await stat(join(cwd, ".git/index"));
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  const prepared = await prepareProjectTask(cwd, scope, signal());
  expect(prepared).toMatchObject({
    cwd,
    source: cwd,
    sourceHead: head,
    files: scope.files,
    testFile: scope.testFile,
  });
  expect(prepared.test.args).toEqual(["--test", scope.testFile]);
  expect(await readFile(join(cwd, "add.mjs"), "utf8")).toBe(source);
  expect(await readFile(join(cwd, ".git/config"), "utf8")).toBe(config);
  expect((await stat(join(cwd, ".git/index"))).mtimeMs).toBe(index.mtimeMs);
  expect(await git(cwd, ["rev-parse", "HEAD"])).toBe(head);
});
it("preserves dirty work and refuses tests, credential scope and native configuration", async () => {
  const cwd = await createSyntheticWorkspace();
  await writeFile(join(cwd, "add.mjs"), "user edit\n");
  await expect(prepareProjectTask(cwd, scope, signal())).rejects.toThrow(
    "uncommitted-changes-preserved",
  );
  expect(await readFile(join(cwd, "add.mjs"), "utf8")).toBe("user edit\n");
  for (const bad of [
    "../add.mjs",
    "auth.json",
    ".env",
    ".claude/settings.json",
    ".gitattributes",
  ])
    expect(() => validateProjectScope({ ...scope, files: [bad] })).toThrow();
  for (const bad of [
    "acceptance.test.mjs; npm install",
    "--eval",
    "../test.mjs",
    "test.ts",
  ])
    expect(() => validateProjectScope({ ...scope, testFile: bad })).toThrow();
  expect(() =>
    validateProjectScope({ ...scope, files: [scope.testFile] }),
  ).toThrow();
  await mkdir(join(cwd, ".claude"));
  await expect(prepareProjectTask(cwd, scope, signal())).rejects.toThrow(
    "project-native-or-harness-configuration",
  );
});
it("preserves an existing session worktree and rejects a different or unknown source", async () => {
  const source = await createSyntheticWorkspace(),
    parent = await mkdtemp(join(tmpdir(), "xh-existing-session-worktree-")),
    cwd = join(parent, "current");
  await git(source, [
    "-c",
    "core.autocrlf=false",
    "worktree",
    "add",
    "-b",
    "xh-offline-session",
    cwd,
  ]);
  const head = await git(source, ["rev-parse", "HEAD"]);
  await expect(prepareProjectTask(cwd, scope, signal())).rejects.toThrow(
    "shared-or-linked-git-directory",
  );
  const prepared = await prepareProjectTask(cwd, scope, signal(), source);
  expect(prepared.cwd).toBe(cwd);
  expect(prepared.sourceHead).toBe(head);
  const other = await createSyntheticWorkspace();
  await expect(prepareProjectTask(cwd, scope, signal(), other)).rejects.toThrow(
    "shared-or-linked-git-directory",
  );
  expect(await git(source, ["rev-parse", "HEAD"])).toBe(head);
  expect(await git(cwd, ["status", "--porcelain"])).toBe("");
});
it("rejects linked configuration without using it or changing its target", async () => {
  const cwd = await createSyntheticWorkspace(),
    parent = await mkdtemp(join(tmpdir(), "xh-linked-git-")),
    external = join(parent, "external.config");
  // A linked .git/config is refused before Git can use it.
  const { rename } = await import("node:fs/promises");
  await rename(join(cwd, ".git/config"), external);
  await link(external, join(cwd, ".git/config"));
  const before = await readFile(external, "utf8");
  const inspection = await projectPreflight(cwd, scope.files, signal());
  expect(inspection).toMatchObject({
    inspectionPassed: false,
    head: null,
    clean: null,
  });
  expect(inspection.blockers).toContain("unsafe-git-configuration");
  expect(await readFile(external, "utf8")).toBe(before);
});
it("runs only after scope/test approval, writes the same session directory, tests failures objectively and fixes with cross-company review", async () => {
  const cwd = await createSyntheticWorkspace(),
    home = await mkdtemp(join(tmpdir(), "xh-normal-native-fake-")),
    marker = join(home, "test-runs.txt");
  const test = await readFile(join(cwd, scope.testFile), "utf8");
  await writeFile(
    join(cwd, scope.testFile),
    `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)},'ran\\n');\n${test}`,
  );
  await git(cwd, ["add", "--all"]);
  await git(cwd, [
    "-c",
    "user.name=Offline test",
    "-c",
    "user.email=offline@local",
    "commit",
    "-qm",
    "immutable offline test",
  ]);
  const original = await readFile(join(cwd, scope.testFile), "utf8"),
    config = await readFile(join(cwd, ".git/config"), "utf8"),
    fake = fixtureAgents("codex", true);
  const run = fake.agents.codex.run;
  fake.agents.codex.run = async (request, abort) => {
    const result = await run(request, abort);
    if (request.phase === "plan")
      for (const task of (
        result.output as { tasks: { acceptance: string[] }[] }
      ).tasks)
        task.acceptance = ["project-node-test"];
    return result;
  };
  const instance = new OfficialWorkflowService({
    home,
    fake: true,
    options: async (path, _provider, planner) => {
      expect(path).toBe(cwd);
      expect(planner).toMatchObject({
        model: "codex:gpt-6-luna",
        effort: "low",
      });
      return fixtureWorkflowOptions(path, {
        agents: fake.agents,
        planner: { provider: "codex", model: "fixture-codex", effort: "low" },
      });
    },
  });
  try {
    const done = instance.submitSession(
      {
        sessionId: "ordinary-session",
        cwd,
        model: "codex:gpt-6-luna",
        effort: "low",
        text: "正しい加算に修正",
        history: [],
        task: scope,
      },
      signal(),
    );
    for (let n = 0; n < 300 && !instance.view().approval; n++)
      await new Promise((r) => setTimeout(r, 10));
    const approval = instance.view().approval;
    expect(approval).toBeDefined();
    expect(fake.requests.map((r) => r.phase)).toEqual(["plan"]);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(cwd, "add.mjs"), "utf8")).toContain("a - b");
    await instance.command({ action: "approve", ...approval! });
    const result = await done,
      record = instance.view().records[0]!.record;
    expect(result.status).toBe("completed");
    expect(record).toMatchObject({
      cwd,
      sessionId: "ordinary-session",
      project: { source: cwd, testFile: scope.testFile },
      correctionRounds: 1,
    });
    expect(record.checks.map((c) => c.tests.every((t) => t.passed))).toEqual([
      false,
      true,
    ]);
    expect(fake.requests.map((r) => r.phase)).toEqual([
      "plan",
      "implement",
      "review",
      "fix",
      "review",
    ]);
    expect(
      fake.requests.every((r) => r.tests.every((t) => t.command === "")),
    ).toBe(true);
    expect(
      await commandApproval(
        fake.requests.find((r) => r.phase === "implement")!,
        {
          command: `node --test ${scope.testFile}`,
          cwd,
          threadId: "thread",
          turnId: "turn",
          itemId: "test",
        },
      ),
    ).toBeNull();
    expect(
      fake.requests
        .filter((r) => r.phase === "review")
        .every((r) => r.model.provider === "claude"),
    ).toBe(true);
    expect(await readFile(marker, "utf8")).toBe("ran\nran\n");
    expect(await readFile(join(cwd, scope.testFile), "utf8")).toBe(original);
    expect(await readFile(join(cwd, ".git/config"), "utf8")).toBe(config);
    expect(await readFile(join(cwd, "add.mjs"), "utf8")).toContain("a+b");
    expect(await git(cwd, ["rev-parse", "HEAD"])).toBe(record.head);
    expect(await git(cwd, ["status", "--porcelain"])).toBe("");
    await instance.close();
    const restored = new OfficialWorkflowService({ home, fake: true });
    try {
      expect(
        (await restored.command({ action: "list" })).records[0]!.record.head,
      ).toBe(record.head);
      expect(
        (await restored.command({ action: "resume", id: record.id })).error,
      ).toContain("自動再開");
    } finally {
      await restored.close();
    }
  } finally {
    await instance.close();
  }
});
