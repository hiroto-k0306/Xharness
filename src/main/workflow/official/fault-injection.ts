import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  normalizeFile,
  WorkflowFailure,
  type TestSpec,
  type WorkspacePort,
} from "./contracts.js";

/**
 * Verification-only fault injection for the fix cycle (user-approved design,
 * 2026-10-07). It never runs in normal use: the mode needs an explicit flag, an
 * explicit environment value and an isolated XHarness home, and it injects only
 * into the dedicated synthetic task it created itself.
 */
export const FIX_CYCLE_SPEC = "fix-cycle-v1";
export const TYPED_ADD_TASK = "typed-add-v1";
export type VerificationMode = typeof FIX_CYCLE_SPEC;

/** Given to the planner and implementer from the start; nothing is hidden. */
export const TYPED_ADD_GOAL =
  'Make add(a, b) in add.mjs follow this specification: when a and b are both finite numbers, return their sum; otherwise (including NaN, Infinity, -Infinity, undefined and numeric strings such as "2", on either side) throw a TypeError. Do not modify the test.';
export const TYPED_ADD_SOURCE = "export const add = (a, b) => a - b;\n";
export const TYPED_ADD_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "./add.mjs";
test("finite numbers are added", () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
  assert.equal(add(0.5, 0.25), 0.75);
  assert.equal(add(1.5, -0.5), 1);
});
test("anything else throws TypeError on either side", () => {
  for (const [a, b] of [
    [NaN, 1],
    [1, NaN],
    [Infinity, 1],
    [1, Infinity],
    [-Infinity, 1],
    [1, -Infinity],
    [undefined, 1],
    [1, undefined],
    ["2", 3],
    [2, "3"],
  ])
    assert.throws(() => add(a, b), TypeError);
});
`;
/** The fixed defect written as X2; labelled, never disguised. */
export const INJECTED_SOURCE =
  "export function add(a, b) {\n  return a - b; // XHarness fault injection (fix-cycle-v1)\n}\n";
export const INJECTED_FILE = "add.mjs";
export const INJECTION_AUTHOR = {
  name: "XHarness fault-injection",
  email: "xharness@local",
};

export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export const typedAddTest = (): TestSpec => ({
  id: "typed-add",
  program: process.versions.electron ? "node" : process.execPath,
  args: ["--test", "acceptance.test.mjs"],
  command: "node --test acceptance.test.mjs",
  timeoutMs: 10000,
});

/** Model calls per phase for one verification run, checked before sending. */
export const FIX_CYCLE_BUDGET = { plan: 1, implement: 1, fix: 1, review: 2 };

/**
 * All three are required: `--official-only` with `--verify-fix-cycle`,
 * `XHARNESS_FAULT_INJECTION=fix-cycle-v1`, and an absolute XHARNESS_HOME that
 * is not the default home. Anything else leaves the mode off.
 */
export function verificationMode(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  defaultHome = join(homedir(), ".xharness"),
): VerificationMode | undefined {
  const home = env.XHARNESS_HOME;
  if (
    !argv.includes("--official-only") ||
    !argv.includes("--verify-fix-cycle") ||
    env.XHARNESS_FAULT_INJECTION !== FIX_CYCLE_SPEC ||
    !home ||
    !isAbsolute(home) ||
    normalizeFile(resolve(home)) === normalizeFile(resolve(defaultHome))
  )
    return undefined;
  return FIX_CYCLE_SPEC;
}

export interface FaultInjectionOptions {
  spec: VerificationMode;
  /** Folder the service created for this task; the workspace must be inside. */
  allowedRoot: string;
}
export type InjectionStageName = "quality" | "injected" | "fix";
export interface InjectionStage {
  stage: InjectionStageName;
  head: string;
  /** Index into record.checks / record.reviews for this exact head. */
  check?: number;
  review?: number;
}
export interface InjectionRecord {
  spec: VerificationMode;
  task: typeof TYPED_ADD_TASK;
  file: typeof INJECTED_FILE;
  contentDigest: string;
  allowedRoot: string;
  state:
    | "pending-quality"
    | "injecting"
    | "injected"
    | "skipped-quality-failed"
    | "ineffective"
    | "failed";
  /** Write attempts; more than zero never injects again. */
  attempts: number;
  stages: InjectionStage[];
  injectedAt?: string;
  error?: string;
}
export const newInjectionRecord = (
  options: FaultInjectionOptions,
): InjectionRecord => ({
  spec: options.spec,
  task: TYPED_ADD_TASK,
  file: INJECTED_FILE,
  contentDigest: sha256(INJECTED_SOURCE),
  allowedRoot: options.allowedRoot,
  state: "pending-quality",
  attempts: 0,
  stages: [],
});

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
};
/**
 * Injects only into the dedicated synthetic task: real paths of the workspace
 * and its Git directory inside the allowed folder, and the base commit holding
 * exactly the typed-add fixture. Throws before any write otherwise.
 */
export async function assertInjectable(
  workspace: WorkspacePort,
  record: { base: string; injection?: InjectionRecord },
  cwd: string,
  signal: AbortSignal,
) {
  const injection = record.injection;
  if (!injection || !workspace.identity)
    throw new WorkflowFailure("fault-injection-not-allowed");
  const root = await realpath(injection.allowedRoot).catch(() => {
    throw new WorkflowFailure("fault-injection-outside-boundary");
  });
  const identity = await workspace.identity(
    record.base,
    ["add.mjs", "acceptance.test.mjs"],
    signal,
  );
  const real = await realpath(cwd);
  if (
    normalizeFile(identity.root) !== normalizeFile(real) ||
    !inside(root, real) ||
    normalizeFile(identity.gitDir) !== normalizeFile(join(real, ".git"))
  )
    throw new WorkflowFailure("fault-injection-outside-boundary");
  if (
    identity.digests["add.mjs"] !== sha256(TYPED_ADD_SOURCE) ||
    identity.digests["acceptance.test.mjs"] !== sha256(TYPED_ADD_TEST)
  )
    throw new WorkflowFailure("fault-injection-not-synthetic-task");
}

/**
 * Test infrastructure trouble stops the run instead of entering the fix path:
 * no exit code (timeout, abort), a negative one (the OS could not start the
 * program), or 125, which the Windows owned-process supervisor returns when it
 * cannot launch or contain the program (owned-process.ts). An assertion
 * failure in node --test exits with 1.
 */
export const OWNED_PROCESS_FAILURE = 125;
export const infrastructureFailure = (tests: { exitCode: number | null }[]) =>
  tests.some(
    (t) =>
      t.exitCode === null ||
      t.exitCode < 0 ||
      t.exitCode === OWNED_PROCESS_FAILURE,
  );
