import { mkdtemp, writeFile, mkdir, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createIndependentValidator,
  type VerifiedValidationSandbox,
} from "./independent-validation.js";
import type { AppServerPort } from "./app-server-rpc.js";
import { harnessTestCommand } from "./operation-approval.js";
const capabilities: VerifiedValidationSandbox = {
  cliVersion: "fixture-only-not-a-real-CLI-claim",
  commandExec: true,
  restrictedRead: true,
  networkDenied: true,
};
const tap = (tests = 1, pass = 1, failed = 0, cancelled = 0) =>
  `TAP version 13\n# tests ${tests}\n# pass ${pass}\n# fail ${failed}\n# cancelled ${cancelled}\n# skipped 0\n# todo 0\n`;
async function setup(
  response: unknown = { exitCode: 0, stdout: tap(), stderr: "PRIVATE SECRET" },
) {
  const cwd = await mkdtemp(join(tmpdir(), "xh-independent-validator-"));
  await writeFile(
    join(cwd, "safe.test.mjs"),
    "// fixture metadata only; never executed",
  );
  const spec = {
    id: "validation",
    program: process.execPath,
    args: ["--test", "--test-reporter=tap", "safe.test.mjs"],
    command: harnessTestCommand(process.execPath, [
      "--test",
      "--test-reporter=tap",
      "safe.test.mjs",
    ]),
    timeoutMs: 1000,
  };
  const server: AppServerPort = {
    request: vi.fn(async (method) => (method === "initialize" ? {} : response)),
    notify: vi.fn(),
    close: vi.fn(),
    subscribe: () => () => {},
    approve: () => {},
  };
  const start = vi.fn(() => server);
  const options = {
    nodeExecutable: process.execPath,
    start,
    verifiedSandbox: capabilities,
  };
  return {
    cwd,
    spec,
    server,
    start,
    options,
    run: createIndependentValidator(options),
  };
}
it("uses only standalone sandboxed exact argv, preserves network denial and saves counts/digest instead of raw output", async () => {
  const f = await setup();
  const result = await f.run(f.spec, f.cwd, new AbortController().signal);
  expect(result.passed).toBe(true);
  expect(result.source).toBe("process");
  const calls = vi.mocked(f.server.request).mock.calls;
  expect(calls.map((c) => c[0])).toEqual(["initialize", "command/exec"]);
  expect(calls[1]![1]).toMatchObject({
    command: [process.execPath, ...f.spec.args],
    cwd: f.cwd,
    timeoutMs: 1000,
    sandboxPolicy: {
      type: "readOnly",
      networkAccess: false,
      access: {
        type: "restricted",
        includePlatformDefaults: true,
        readableRoots: [f.cwd, process.execPath],
      },
    },
    env: { NODE_OPTIONS: null, NODE_PATH: null },
  });
  expect(result.output).not.toContain("PRIVATE");
  expect(JSON.parse(result.output).outputDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(f.server.close).toHaveBeenCalledOnce();
});
it("unverified installed runtime stops before any RPC or execution", async () => {
  const f = await setup();
  await expect(
    createIndependentValidator({ ...f.options, verifiedSandbox: undefined })(
      f.spec,
      f.cwd,
      new AbortController().signal,
    ),
  ).rejects.toThrow("validation-unavailable");
  expect(f.start).not.toHaveBeenCalled();
});
it.each([
  { exitCode: 0, stdout: tap(0, 0), stderr: "" },
  { exitCode: 0, stdout: tap(2, 1, 0, 1), stderr: "" },
  { exitCode: 1, stdout: tap(), stderr: "" },
  { exitCode: 0, stdout: "arbitrary assertion that tests passed", stderr: "" },
])(
  "refuses zero, cancelled, failing or unconfirmed tests %j",
  async (response) => {
    const f = await setup(response);
    expect(
      (await f.run(f.spec, f.cwd, new AbortController().signal)).passed,
    ).toBe(false);
  },
);
it.each(["../safe.test.mjs", ".env/secret.test.js", "auth.json", "--eval"])(
  "rejects unsafe or non-test argument %s before RPC",
  async (file) => {
    const f = await setup(),
      args = ["--test", "--test-reporter=tap", file];
    await expect(
      f.run(
        { ...f.spec, args, command: harnessTestCommand(f.spec.program, args) },
        f.cwd,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(f.start).not.toHaveBeenCalled();
  },
);
it.each(["symlink", "hardlink"])("rejects %s test paths", async (kind) => {
  const f = await setup();
  await mkdir(join(f.cwd, "nested"));
  if (kind === "symlink")
    await symlink(
      join(f.cwd, "safe.test.mjs"),
      join(f.cwd, "nested", "unsafe.test.mjs"),
    );
  else
    await link(
      join(f.cwd, "safe.test.mjs"),
      join(f.cwd, "nested", "unsafe.test.mjs"),
    );
  const args = ["--test", "--test-reporter=tap", "nested/unsafe.test.mjs"];
  await expect(
    f.run(
      { ...f.spec, args, command: harnessTestCommand(f.spec.program, args) },
      f.cwd,
      new AbortController().signal,
    ),
  ).rejects.toThrow("independent-validation-path-unsafe");
  expect(f.start).not.toHaveBeenCalled();
});
it("unsupported method errors are fixed unavailable errors without fallback or leaked messages", async () => {
  const f = await setup();
  vi.mocked(f.server.request).mockRejectedValue(Error("PRIVATE METHOD ERROR"));
  await expect(
    f.run(f.spec, f.cwd, new AbortController().signal),
  ).rejects.toThrow("validation-unavailable");
  expect(f.server.close).toHaveBeenCalledOnce();
});
it("pre-cancelled validation starts no process", async () => {
  const f = await setup(),
    abort = new AbortController();
  abort.abort();
  await expect(f.run(f.spec, f.cwd, abort.signal)).rejects.toThrow(
    "independent-validation-cancelled",
  );
  expect(f.start).not.toHaveBeenCalled();
});
it("cancels a running standalone command and closes its dedicated server", async () => {
  const f = await setup(),
    abort = new AbortController();
  vi.mocked(f.server.request).mockImplementation(async (method) => {
    if (method === "initialize" || method === "command/exec/terminate")
      return {};
    abort.abort();
    return new Promise(() => {});
  });
  await expect(f.run(f.spec, f.cwd, abort.signal)).rejects.toThrow(
    "independent-validation-cancelled",
  );
  expect(vi.mocked(f.server.request).mock.calls.map((c) => c[0])).toEqual([
    "initialize",
    "command/exec",
    "command/exec/terminate",
  ]);
  expect(f.server.close).toHaveBeenCalledOnce();
});
it("refuses excessive or malformed output without persisting raw strings", async () => {
  const f = await setup({
    exitCode: 0,
    stdout: "PRIVATE".repeat(10000),
    stderr: "",
  });
  await expect(
    f.run(f.spec, f.cwd, new AbortController().signal),
  ).rejects.toThrow("independent-validation-response-invalid");
});
