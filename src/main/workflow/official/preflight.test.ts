import { afterEach, expect, it } from "vitest";
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { createSyntheticWorkspace } from "./fixtures.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  workflowGitEnvironment,
  workflowGitPolicyArgs,
  gitWorkspace,
} from "./workspace.js";
import { projectPreflight } from "./preflight.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
});
async function fixture() {
  const root = await createSyntheticWorkspace();
  roots.push(root);
  return root;
}
it("accepts a clean tracked built-in attributes file through inspection, commit and diff", async () => {
  const root = await fixture(),
    signal = new AbortController().signal;
  await writeFile(
    join(root, ".gitattributes"),
    "* text=auto eol=lf\n*.svg -text\n*.png binary\n",
  );
  const run = (args: string[]) =>
    promisify(execFile)(
      "git",
      [...workflowGitPolicyArgs(), "-c", `safe.directory=${root}`, ...args],
      { cwd: root, windowsHide: true, env: workflowGitEnvironment() },
    );
  await run(["add", "--", ".gitattributes"]);
  await run([
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@local",
    "commit",
    "-qm",
    "fixture: safe attributes",
  ]);
  const before = await readFile(join(root, ".gitattributes"));
  expect(await projectPreflight(root, ["add.mjs"], signal)).toMatchObject({
    inspectionPassed: true,
    clean: true,
  });
  const port = gitWorkspace(root, (s) => s),
    base = await port.inspect(signal);
  await writeFile(join(root, "add.mjs"), "export const add=(a,b)=>a+b;\n");
  const head = await port.commit(["add.mjs"], signal);
  expect((await port.snapshot(base.head, head, signal)).files).toEqual([
    "add.mjs",
  ]);
  expect(await readFile(join(root, ".gitattributes"))).toEqual(before);
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested/.gitattributes"), "* diff=driver\n");
  await expect(port.inspect(signal)).rejects.toThrow(
    "git-attributes-not-supported",
  );
});
it("does not run configured clean filters or refresh the index during inspection", async () => {
  const root = await fixture(),
    config = join(root, ".git/config");
  await appendFile(
    config,
    "\n[filter \"probe\"]\n\tclean = node -e \"require('fs').writeFileSync('preflight-filter-ran','bad')\"\n",
  );
  await writeFile(join(root, ".gitattributes"), "add.mjs filter=probe\n");
  await writeFile(join(root, "add.mjs"), "user edit\n");
  const original = await readFile(config, "utf8"),
    index = await stat(join(root, ".git/index"));
  const result = await projectPreflight(
    root,
    ["add.mjs"],
    new AbortController().signal,
  );
  expect(result.clean).toBeNull();
  expect(result.blockers).toContain("local-git-execution-configuration");
  await expect(stat(join(root, "preflight-filter-ran"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(config, "utf8")).toBe(original);
  expect((await stat(join(root, ".git/index"))).mtimeMs).toBe(index.mtimeMs);
});
it("recognizes normalized conditional-include keys without following their targets", async () => {
  const root = await fixture();
  await appendFile(
    join(root, ".git/config"),
    '\n[includeIf "gitdir:**"]\n\tpath = ../does-not-exist.conf\n',
  );
  const result = await projectPreflight(
    root,
    ["add.mjs"],
    new AbortController().signal,
  );
  expect(result.clean).toBeNull();
  expect(result.blockers).toContain("local-git-execution-configuration");
});

it("allows built-in attributes and preserves unknown cleanliness for unsafe attributes", async () => {
  const root = await fixture();
  await writeFile(
    join(root, ".gitattributes"),
    "* text=auto eol=lf\n*.png binary\n",
  );
  // Untracked attributes are safe to interpret; their uncommitted presence still stops execution.
  const measured = await projectPreflight(
    root,
    ["add.mjs"],
    new AbortController().signal,
  );
  expect(measured.clean).toBe(false);
  expect(measured.blockers).not.toContain(
    "project-configuration:.gitattributes",
  );
  expect(measured.blockers).toContain("uncommitted-changes-preserved");
  await writeFile(join(root, ".gitattributes"), "* filter=unknown\n");
  const rejected = await projectPreflight(
    root,
    ["add.mjs"],
    new AbortController().signal,
  );
  expect(rejected.clean).toBeNull();
  expect(rejected.blockers).toContain("project-configuration:.gitattributes");
});
it("inspects a general project without enabling native DAG or changing HEAD/files", async () => {
  const root = await fixture(),
    before = await readFile(join(root, "add.mjs"), "utf8");
  const first = await projectPreflight(
    root,
    ["add.mjs"],
    new AbortController().signal,
  );
  expect(first).toMatchObject({
    inspectionPassed: true,
    clean: true,
    nativeDagEnabled: false,
    filesystemIsolationVerified: false,
  });
  await writeFile(join(root, "add.mjs"), "user edit\n");
  await writeFile(
    join(root, ".mcp.json"),
    "fixture metadata: must never execute\n",
  );
  const next = await projectPreflight(
    root,
    ["add.mjs"],
    new AbortController().signal,
  );
  expect(next.head).toBe(first.head);
  expect(next.blockers).toEqual(
    expect.arrayContaining([
      "uncommitted-changes-preserved",
      "project-configuration:.mcp.json",
    ]),
  );
  expect(await readFile(join(root, "add.mjs"), "utf8")).toBe("user edit\n");
  expect(before).not.toBe("user edit\n");
});
it("rejects junction, absolute, traversal, hidden settings and duplicate scope without writing outside", async () => {
  const root = await fixture(),
    outside = await fixture();
  await mkdir(join(root, ".claude"));
  await symlink(outside, join(root, "junction"), "junction");
  const sentinel = await readFile(join(outside, "add.mjs"), "utf8");
  const result = await projectPreflight(
    root,
    [
      "junction/add.mjs",
      join(outside, "add.mjs"),
      "../outside.mjs",
      "add.mjs",
      "ADD.MJS",
    ],
    new AbortController().signal,
  );
  expect(result.blockers).toEqual(
    expect.arrayContaining([
      "unsafe-planned-path",
      "duplicate-files",
      "project-configuration:.claude",
    ]),
  );
  expect(await readFile(join(outside, "add.mjs"), "utf8")).toBe(sentinel);
});
