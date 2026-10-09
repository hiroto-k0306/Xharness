import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AppServerPort } from "./app-server-rpc.js";
import {
  relativeFile,
  WorkflowFailure,
  type TestSpec,
  type TestEvidence,
} from "./contracts.js";
import { harnessTestCommand } from "./operation-approval.js";
import { abortable } from "../../connections/siwc-http-utils.js";

export interface VerifiedValidationSandbox {
  /** Evidence supplied by runtime integration, not inferred from a version number. */
  cliVersion: string;
  commandExec: true;
  restrictedRead: true;
  networkDenied: true;
}
export interface IndependentValidatorOptions {
  start(cwd: string): AppServerPort;
  nodeExecutable: string;
  /** Absent for unverified installed runtimes: stop before executing anything. */
  verifiedSandbox?: VerifiedValidationSandbox;
}
function fail(code: string): never {
  throw new WorkflowFailure(code);
}
const MAX_OUTPUT = 65536;
function tapCounts(output: string) {
  const counts: Record<string, number> = {};
  for (const name of [
    "tests",
    "pass",
    "fail",
    "cancelled",
    "skipped",
    "todo",
  ]) {
    const matches = [
      ...output.matchAll(new RegExp(`^# ${name} ([0-9]+)\\r?$`, "gm")),
    ];
    if (matches.length !== 1) return undefined;
    const count = Number(matches[0]![1]);
    if (!Number.isSafeInteger(count) || count > 1000000) return undefined;
    counts[name] = count;
  }
  if (
    !/^TAP version 13\r?$/m.test(output) ||
    counts.tests! <= 0 ||
    counts.pass! <= 0 ||
    counts.tests !==
      counts.pass! +
        counts.fail! +
        counts.cancelled! +
        counts.skipped! +
        counts.todo!
  )
    return undefined;
  return counts;
}
async function safeTests(spec: TestSpec, cwd: string, node: string) {
  if (
    !isAbsolute(cwd) ||
    !isAbsolute(node) ||
    spec.program !== node ||
    spec.args[0] !== "--test" ||
    spec.args[1] !== "--test-reporter=tap" ||
    spec.args.length < 3 ||
    spec.args.length > 22 ||
    spec.command !== harnessTestCommand(node, spec.args) ||
    !Number.isInteger(spec.timeoutMs) ||
    spec.timeoutMs < 1 ||
    spec.timeoutMs > 60000
  )
    fail("independent-validation-input-invalid");
  const root = await realpath(cwd);
  if (root !== resolve(cwd) || (await lstat(cwd)).isSymbolicLink())
    fail("independent-validation-path-unsafe");
  const files = spec.args.slice(2);
  if (new Set(files).size !== files.length)
    fail("independent-validation-input-invalid");
  for (const file of files) {
    if (
      !relativeFile.safeParse(file).success ||
      !/\.test\.(?:mjs|js)$/.test(file)
    )
      fail("independent-validation-path-unsafe");
    let target = root;
    const segments = file.replaceAll("\\", "/").split("/");
    for (let index = 0; index < segments.length; index++) {
      target = join(target, segments[index]!);
      const stat = await lstat(target);
      if (
        stat.isSymbolicLink() ||
        (await realpath(target)) !== target ||
        (index === segments.length - 1
          ? !stat.isFile() || stat.nlink !== 1
          : !stat.isDirectory())
      )
        fail("independent-validation-path-unsafe");
    }
  }
  return root;
}
/** Separate approved test process; no model, thread, shell, or unsandboxed fallback. */
export function createIndependentValidator(
  options: IndependentValidatorOptions,
) {
  return async (
    spec: TestSpec,
    cwd: string,
    signal: AbortSignal,
  ): Promise<TestEvidence> => {
    if (signal.aborted) fail("independent-validation-cancelled");
    if (
      !options.verifiedSandbox?.commandExec ||
      !options.verifiedSandbox.restrictedRead ||
      !options.verifiedSandbox.networkDenied ||
      !options.verifiedSandbox.cliVersion
    )
      fail("validation-unavailable");
    let root: string;
    try {
      root = await safeTests(spec, cwd, options.nodeExecutable);
    } catch (error) {
      if (error instanceof WorkflowFailure) throw error;
      fail("independent-validation-path-unsafe");
    }
    if (signal.aborted) fail("independent-validation-cancelled");
    let server: AppServerPort;
    try {
      server = options.start(root!);
    } catch {
      fail("validation-unavailable");
    }
    const requestSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(spec.timeoutMs),
      ]),
      processId = randomUUID(),
      started = Date.now();
    const cancel = () => {
      void server!
        .request(
          "command/exec/terminate",
          { processId },
          AbortSignal.timeout(10000),
        )
        .catch(() => {});
    };
    requestSignal.addEventListener("abort", cancel, { once: true });
    try {
      await abortable(
        server!.request(
          "initialize",
          {
            clientInfo: {
              name: "xharness_independent_validation",
              version: "0.0.0",
            },
            capabilities: { experimentalApi: true },
          },
          requestSignal,
        ),
        requestSignal,
      );
      server!.notify("initialized", {});
      const raw = await abortable(
        server!.request(
          "command/exec",
          {
            command: [spec.program, ...spec.args],
            cwd: root!,
            processId,
            timeoutMs: spec.timeoutMs,
            outputBytesCap: MAX_OUTPUT,
            sandboxPolicy: {
              type: "readOnly",
              networkAccess: false,
              access: {
                type: "restricted",
                includePlatformDefaults: true,
                readableRoots: [root!, options.nodeExecutable],
              },
            },
            env: {
              NODE_OPTIONS: null,
              NODE_PATH: null,
              ELECTRON_RUN_AS_NODE: null,
            },
          },
          requestSignal,
        ),
        requestSignal,
      );
      if (signal.aborted) fail("independent-validation-cancelled");
      if (requestSignal.aborted) fail("independent-validation-timeout");
      if (!raw || typeof raw !== "object")
        fail("independent-validation-response-invalid");
      const result = raw as Record<string, unknown>;
      if (
        !Number.isInteger(result.exitCode) ||
        typeof result.stdout !== "string" ||
        typeof result.stderr !== "string" ||
        Buffer.byteLength(result.stdout) >= MAX_OUTPUT ||
        Buffer.byteLength(result.stderr) >= MAX_OUTPUT
      )
        fail("independent-validation-response-invalid");
      const counts = tapCounts(result.stdout);
      const outputDigest = createHash("sha256")
        .update(JSON.stringify([result.stdout, result.stderr]))
        .digest("hex");
      const passed =
        result.exitCode === 0 &&
        !!counts &&
        counts.fail === 0 &&
        counts.cancelled === 0 &&
        counts.todo === 0;
      return {
        id: spec.id,
        exitCode: result.exitCode as number,
        passed,
        elapsedMs: Date.now() - started,
        source: "process",
        output: JSON.stringify({
          mechanism: "official-command-exec",
          status: passed ? "passed" : "failed-or-unconfirmed",
          counts: counts ?? null,
          outputDigest,
        }),
      };
    } catch (error) {
      if (signal.aborted) fail("independent-validation-cancelled");
      if (requestSignal.aborted) fail("independent-validation-timeout");
      if (error instanceof WorkflowFailure) throw error;
      fail("validation-unavailable");
    } finally {
      requestSignal.removeEventListener("abort", cancel);
      server!.close();
    }
  };
}
