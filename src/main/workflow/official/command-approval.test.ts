import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandApproval } from "./command-approval.js";
import type { AgentRequest } from "./contracts.js";
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "xh-approval-"));
  await writeFile(join(cwd, "add.mjs"), "synthetic");
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
const request = () =>
  ({
    requestId: "11111111-1111-4111-8111-111111111111",
    cwd,
    files: ["add.mjs"],
    tests: [{ command: "node --test add.test.mjs" }],
  }) as AgentRequest;
const params = (command: string) => ({
  command,
  cwd,
  threadId: "thread",
  turnId: "turn",
  itemId: "item",
});
it("separates registered tests and a concrete scoped operation", async () => {
  expect(
    await commandApproval(request(), params("node --test add.test.mjs")),
  ).toBe("test");
  expect(
    await commandApproval(
      request(),
      params("Get-Content -LiteralPath 'add.mjs' -Raw"),
    ),
  ).toMatchObject({ targets: ["add.mjs"], sessionId: "thread" });
});
it.each([
  "Get-Content ../outside",
  "Get-Content .env",
  "Get-Content *",
  "Get-Content add.mjs; whoami",
  "Get-Content $(whoami)",
  "Get-Content add.mjs | Invoke-Expression",
  "Get-Content add.mjs > outside",
  "git status",
  "npm install",
  "pwsh -EncodedCommand abc",
  "Set-Content add.mjs code",
])(
  "rejects prohibited or unparseable operation before prompting: %s",
  async (command) => {
    expect(await commandApproval(request(), params(command))).toBeNull();
  },
);
it("rejects external permissions, wrong cwd and compound registered commands", async () => {
  expect(
    await commandApproval(request(), {
      ...params("Get-Content add.mjs"),
      additionalPermissions: {},
    }),
  ).toBeNull();
  expect(
    await commandApproval(request(), {
      ...params("Get-Content add.mjs"),
      cwd: tmpdir(),
    }),
  ).toBeNull();
  const r = request();
  r.tests[0]!.command = "node --test add.test.mjs; whoami";
  expect(await commandApproval(r, params(r.tests[0]!.command))).toBeNull();
});
it("rejects quote concatenation rather than authorizing a differently tokenized path", async () => {
  const r = request();
  r.files = ["ab"];
  await writeFile(join(cwd, "ab"), "synthetic");
  expect(await commandApproval(r, params("Get-Content 'a''b'"))).toBeNull();
  expect(await commandApproval(r, params("Get-Content a'b'"))).toBeNull();
});
it("rechecks links even for an approved lexical path", async () => {
  await rm(join(cwd, "add.mjs"));
  await symlink(join(cwd, "missing"), join(cwd, "add.mjs"), "junction");
  expect(
    await commandApproval(request(), params("Get-Content add.mjs")),
  ).toBeNull();
});
