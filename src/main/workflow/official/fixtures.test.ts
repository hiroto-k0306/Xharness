import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));
import { createSyntheticWorkspace } from "./fixtures.js";
import { OfficialWorkflowService } from "./service.js";
import { TYPED_ADD_SOURCE, TYPED_ADD_TEST } from "./fault-injection.js";
import { workflowGitEnvironment, workflowGitPolicyArgs } from "./workspace.js";

let parent: string;
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "xh-preparation-test-"));
  execFile.mockReset();
  execFile.mockImplementation((_program, _args, _options, callback) => {
    callback(null, "", "");
  });
});
afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

it("shows preparation evidence in the product view before any agent lookup", async () => {
  execFile.mockImplementation((_program, _args, _options, callback) => {
    callback(Object.assign(new Error("private stderr"), { code: "ENOENT" }));
  });
  const options = vi.fn();
  const service = new OfficialWorkflowService({
    home: parent,
    fake: true,
    options,
  });
  try {
    const view = await service.command({ action: "create", provider: "codex" });
    expect(view.error).toBe(
      "合成課題のGit準備に失敗しました（init: code ENOENT, exit 不明）。再送していません。",
    );
    expect(view.records).toHaveLength(0);
    expect(view.activeId).toBeUndefined();
    expect(options).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledTimes(1);
  } finally {
    await service.close();
  }
});

it.each([
  [0, "init", "ENOENT", "不明"],
  [0, "init", "EACCES", "不明"],
  [1, "add", "EPERM", "不明"],
  [2, "commit", 128, "128"],
  [0, "init", "secret-config-value", "不明"],
] as const)(
  "reports bounded preparation failure at %s without retry or native output",
  async (index, step, code, exit) => {
    let calls = 0;
    execFile.mockImplementation((_program, _args, _options, callback) => {
      const error =
        calls++ === index
          ? Object.assign(new Error("private native message"), {
              code,
              stdout: "private stdout",
              stderr: "private stderr",
            })
          : null;
      callback(error, "private stdout", "private stderr");
    });
    const error = await createSyntheticWorkspace(
      "fixture-",
      parent,
      "typed-add-v1",
    ).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(`合成課題のGit準備に失敗しました（${step}:`);
    expect(message).toContain(`exit ${exit}`);
    expect(message).toContain(
      `code ${typeof code === "string" && code !== "secret-config-value" ? code : "unknown"}`,
    );
    expect(message).not.toMatch(/private|secret-config/);
    expect(execFile).toHaveBeenCalledTimes(index + 1);
    const directories = await readdir(parent);
    expect(directories).toHaveLength(1);
    expect(
      await readFile(join(parent, directories[0]!, "add.mjs"), "utf8"),
    ).toBe(TYPED_ADD_SOURCE);
  },
);

it("keeps fixture, cwd, Git identity and command scope unchanged", async () => {
  const cwd = await createSyntheticWorkspace(
    "fixture-",
    parent,
    "typed-add-v1",
  );
  expect(await readFile(join(cwd, "acceptance.test.mjs"), "utf8")).toBe(
    TYPED_ADD_TEST,
  );
  const calls = execFile.mock.calls;
  expect(calls).toHaveLength(3);
  for (const [program, args, options] of calls) {
    expect(program).toBe("git");
    const prefix = [...workflowGitPolicyArgs(), "-c", `safe.directory=${cwd}`];
    expect(args.slice(0, prefix.length)).toEqual(prefix);
    expect(options).toEqual({
      cwd,
      windowsHide: true,
      env: workflowGitEnvironment(),
    });
  }
  expect(calls[2]![1].slice(workflowGitPolicyArgs().length + 2)).toEqual([
    "-c",
    "user.name=XHarness",
    "-c",
    "user.email=xharness@local",
    "commit",
    "-qm",
    "fixture: typed-add-v1",
  ]);
});
