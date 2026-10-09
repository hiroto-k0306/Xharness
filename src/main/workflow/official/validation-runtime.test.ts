import { it, expect, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createValidationRuntime,
  validationSchemaSupported,
  type ValidationRuntimePorts,
} from "./validation-runtime.js";
import type { AppServerPort } from "./app-server-rpc.js";
import { harnessTestCommand } from "./operation-approval.js";
const schema = () => ({
  "CommandExecParams.json": {
    type: "object",
    properties: {
      command: { type: "array" },
      cwd: { type: "string" },
      processId: { type: "string" },
      timeoutMs: { type: "integer" },
      outputBytesCap: { type: "integer" },
      env: {
        type: "object",
        additionalProperties: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      sandboxPolicy: {
        oneOf: [
          {
            type: "object",
            properties: {
              type: { const: "readOnly" },
              networkAccess: { type: "boolean" },
              access: {
                type: "object",
                properties: {
                  type: { const: "restricted" },
                  includePlatformDefaults: { type: "boolean" },
                  readableRoots: { type: "array" },
                },
              },
            },
          },
        ],
      },
    },
  },
  "CommandExecTerminateParams.json": {
    type: "object",
    properties: { processId: { type: "string" } },
  },
});
const goodProof = {
  inside: true,
  outside: true,
  writeInside: true,
  writeOutside: true,
  network: true,
};
async function fixture(
  run: (f: {
    exe: string;
    root: string;
    ports: ValidationRuntimePorts;
    starts: ReturnType<typeof vi.fn>;
    runs: ReturnType<typeof vi.fn>;
    server: AppServerPort & { waitClosed(): Promise<void> };
    generated: string[];
    setProof(value: unknown): void;
    setCancel(mode: string): void;
    setSchema(value: Record<string, unknown>): void;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "xh-validation-runtime-test-")),
    exe = join(root, "synthetic-cli.exe");
  await writeFile(exe, "synthetic binary");
  let declarations = schema() as Record<string, unknown>,
    proof: unknown = goodProof,
    cancelMode = "valid";
  const generated: string[] = [];
  let phase = 0,
    finish: ((value: unknown) => void) | undefined,
    ready = "";
  const server = {
    request: vi.fn(async (method: string, params: unknown) => {
      if (method === "initialize") return {};
      if (method === "command/exec/terminate") {
        finish?.({
          exitCode: 137,
          stdout: cancelMode === "no-ready" ? "" : ready,
          stderr: "",
        });
        return {};
      }
      if (method !== "command/exec") throw Error("Forbidden fixture RPC");
      const input = params as { command: string[] };
      if (phase++ === 0)
        return { exitCode: 0, stdout: JSON.stringify(proof), stderr: "" };
      if (phase === 2) {
        ready = input.command[3]!;
        if (cancelMode === "early")
          return { exitCode: 1, stdout: ready, stderr: "" };
        return await new Promise((accept) => {
          finish = accept;
        });
      }
      return {
        exitCode: 0,
        stdout:
          "TAP version 13\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n",
        stderr: "PRIVATE",
      };
    }),
    notify: vi.fn(),
    subscribe: () => () => {},
    approve: vi.fn(),
    close: vi.fn(),
    waitClosed: vi.fn(async () => {}),
  };
  const starts = vi.fn(() => server);
  const runs = vi.fn(async (_program: string, args: string[], cwd: string) => {
    if (args[0] === "--version") return "codex-cli 0.159.0-alpha.3";
    if (args[0] === "app-server") {
      const output = args.at(-1)!;
      await mkdir(output);
      generated.push(cwd);
      for (const [name, body] of Object.entries(declarations))
        await writeFile(join(output, name), JSON.stringify(body));
      return "";
    }
    return JSON.stringify({ read: true, write: true, network: true });
  });
  const ports: ValidationRuntimePorts = {
    platform: "win32",
    runOwned: runs,
    start: starts,
  };
  try {
    await run({
      exe,
      root,
      ports,
      starts,
      runs,
      server,
      generated,
      setProof: (v) => {
        proof = v;
      },
      setCancel: (v) => {
        cancelMode = v;
      },
      setSchema: (v) => {
        declarations = v;
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
}
const create = (f: { exe: string; ports: ValidationRuntimePorts }) =>
  createValidationRuntime({
    executable: f.exe,
    nodeExecutable: process.execPath,
    signal: new AbortController().signal,
    ports: f.ports,
  });
it("unverified platform never starts a CLI or manufactures support", async () =>
  fixture(async (f) => {
    f.ports.platform = "linux";
    expect(await create(f)).toEqual({
      available: false,
      reason: "validation-platform-unsupported",
    });
    expect(f.runs).not.toHaveBeenCalled();
    expect(f.starts).not.toHaveBeenCalled();
  }));
it("requires exact declared security fields, not a permissive unknown-field schema", () => {
  expect(validationSchemaSupported(schema())).toBe(true);
  for (const field of [
    "sandboxPolicy",
    "env",
    "processId",
    "timeoutMs",
    "outputBytesCap",
  ]) {
    const value = schema();
    delete (
      value["CommandExecParams.json"].properties as Record<string, unknown>
    )[field];
    expect(validationSchemaSupported(value)).toBe(false);
  }
  expect(
    validationSchemaSupported({
      "CommandExecParams.json": { type: "object", additionalProperties: true },
    }),
  ).toBe(false);
});
it("schema absence stops before canary execution and removes generated diagnostics", async () =>
  fixture(async (f) => {
    f.setSchema({});
    expect(await create(f)).toEqual({
      available: false,
      reason: "validation-schema-unverified",
    });
    expect(f.starts).not.toHaveBeenCalled();
    await expect(access(f.generated[0]!)).rejects.toThrow();
  }));
it.each(Object.keys(goodProof))(
  "refuses missing %s isolation evidence",
  async (field) =>
    fixture(async (f) => {
      f.setProof({ ...goodProof, [field]: false });
      expect(await create(f)).toEqual({
        available: false,
        reason: "validation-isolation-unverified",
      });
      expect(f.server.close).toHaveBeenCalled();
      expect(f.server.waitClosed).toHaveBeenCalled();
    }),
);
it.each(["early", "no-ready"])(
  "rejects %s cancellation evidence",
  async (mode) =>
    fixture(async (f) => {
      f.setCancel(mode);
      expect(await create(f)).toEqual({
        available: false,
        reason: "validation-cancel-unverified",
      });
    }),
);
it("host positive controls must succeed before sandbox failures count as proof", async () =>
  fixture(async (f) => {
    const original = f.ports.runOwned;
    f.ports.runOwned = async (...args) =>
      args[1][0] === "-e"
        ? JSON.stringify({ read: true, write: true, network: false })
        : original(...args);
    expect(await create(f)).toEqual({
      available: false,
      reason: "validation-probe-baseline-failed",
    });
    expect(f.starts).not.toHaveBeenCalled();
  }));
it("successful mock support binds identity, refuses provider RPC requests and awaits cleanup for actual validation", async () =>
  fixture(async (f) => {
    const result = await create(f);
    expect(result.available).toBe(true);
    if (!result.available) throw Error(result.reason);
    const request = vi
      .mocked(f.server.request)
      .mock.calls.find((c) => c[0] === "command/exec")![1] as Record<
      string,
      unknown
    >;
    expect(request).toMatchObject({
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
        access: { type: "restricted", includePlatformDefaults: true },
      },
      env: { NODE_OPTIONS: null, NODE_PATH: null, ELECTRON_RUN_AS_NODE: null },
    });
    expect(vi.mocked(f.server.request).mock.calls.map((c) => c[0])).toEqual([
      "initialize",
      "command/exec",
      "command/exec",
      "command/exec/terminate",
    ]);
    const deny = vi.mocked(f.server.approve).mock.calls[0]![0] as (
      method: string,
      params: unknown,
    ) => Promise<unknown>;
    await expect(deny("config/write", {})).rejects.toThrow(
      "validation-rpc-request-refused",
    );
    const cwd = join(f.root, "integration");
    await mkdir(cwd);
    await writeFile(join(cwd, "safe.test.mjs"), "// synthetic");
    const args = ["--test", "--test-reporter=tap", "safe.test.mjs"];
    const evidence = await result.validateIntegration(
      {
        id: "test",
        program: process.execPath,
        args,
        command: harnessTestCommand(process.execPath, args),
        timeoutMs: 1000,
      },
      cwd,
      new AbortController().signal,
    );
    expect(evidence.passed).toBe(true);
    expect(evidence.output).not.toContain("PRIVATE");
    expect(f.server.waitClosed).toHaveBeenCalledTimes(2);
    await writeFile(f.exe, "updated binary");
    await expect(
      result.validateIntegration(
        {
          id: "test",
          program: process.execPath,
          args,
          command: harnessTestCommand(process.execPath, args),
          timeoutMs: 1000,
        },
        cwd,
        new AbortController().signal,
      ),
    ).rejects.toThrow("validation-runtime-changed");
    expect(f.starts).toHaveBeenCalledTimes(2);
  }));
it("actual validation cancellation waits for owned process closure before rejection", async () =>
  fixture(async (f) => {
    const result = await create(f);
    if (!result.available) throw Error(result.reason);
    const cwd = join(f.root, "integration");
    await mkdir(cwd);
    await writeFile(join(cwd, "safe.test.mjs"), "// synthetic");
    vi.mocked(f.server.request).mockImplementation(async (method) =>
      method === "initialize" ? {} : await new Promise(() => {}),
    );
    let release: (() => void) | undefined;
    vi.mocked(f.server.waitClosed).mockImplementation(
      () =>
        new Promise<void>((accept) => {
          release = accept;
        }),
    );
    const controller = new AbortController(),
      args = ["--test", "--test-reporter=tap", "safe.test.mjs"];
    let finished = false;
    const running = result
      .validateIntegration(
        {
          id: "test",
          program: process.execPath,
          args,
          command: harnessTestCommand(process.execPath, args),
          timeoutMs: 1000,
        },
        cwd,
        controller.signal,
      )
      .catch((error) => {
        finished = true;
        return error;
      });
    await vi.waitFor(() => expect(f.starts).toHaveBeenCalledTimes(2));
    controller.abort();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(finished).toBe(false);
    release!();
    expect((await running).message).toBe("independent-validation-cancelled");
  }));
it("changed Node binary invalidates proven support before starting validation", async () =>
  fixture(async (f) => {
    const node = join(f.root, "node.exe");
    await writeFile(node, "synthetic node");
    const result = await createValidationRuntime({
      executable: f.exe,
      nodeExecutable: node,
      signal: new AbortController().signal,
      ports: f.ports,
    });
    if (!result.available) throw Error(result.reason);
    await writeFile(node, "updated node");
    const args = ["--test", "--test-reporter=tap", "safe.test.mjs"];
    await expect(
      result.validateIntegration(
        {
          id: "test",
          program: node,
          args,
          command: harnessTestCommand(node, args),
          timeoutMs: 1000,
        },
        f.root,
        new AbortController().signal,
      ),
    ).rejects.toThrow("validation-runtime-changed");
    expect(f.starts).toHaveBeenCalledTimes(1);
  }));
it(
  "uncertain owned cleanup throws, preserves diagnostics and cannot become serial availability",
  async () =>
    fixture(async (f) => {
      vi.mocked(f.server.waitClosed).mockImplementation(
        () => new Promise(() => {}),
      );
      try {
        await expect(create(f)).rejects.toThrow(
          "validation-cleanup-unverified",
        );
        await expect(access(f.generated[0]!)).resolves.toBeUndefined();
      } finally {
        await rm(f.generated[0]!, {
          recursive: true,
          force: true,
          maxRetries: 5,
        });
      }
    }),
  10000,
);
