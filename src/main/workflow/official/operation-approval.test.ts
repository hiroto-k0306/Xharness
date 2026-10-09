import { afterEach, expect, it, vi } from "vitest";
import {
  OPERATION_APPROVAL_MS,
  OperationApprovals,
  harnessTestCommand,
  harnessTestSchema,
} from "./operation-approval.js";
const operation = {
  requestId: "11111111-1111-4111-8111-111111111111",
  sessionId: "session",
  turnId: "turn",
  itemId: "item",
  command: "Get-Content add.mjs",
  cwd: "workspace",
  targets: ["add.mjs"],
  reason: "Inspect source",
};

it("flow grant requires a current matching decision, stays in its cwd and expires on cancel/restart", async () => {
  const approvals = new OperationApprovals();
  const signal = new AbortController().signal;
  const first = approvals.ask("workflow", operation, signal);
  const pending = approvals.view()!;
  approvals.decide("workflow", pending.approvalId, "changed", true, true);
  expect(approvals.view()).toEqual(pending);
  approvals.decide("workflow", pending.approvalId, pending.digest, true, true);
  expect(await first).toBe(true);
  expect(
    await approvals.ask("workflow", { ...operation, itemId: "next" }, signal),
  ).toBe(true);
  const outside = approvals.ask(
    "workflow",
    { ...operation, cwd: "other" },
    signal,
  );
  expect(approvals.view()).toBeTruthy();
  approvals.cancel();
  expect(await outside).toBe("cancelled");
  const again = approvals.ask("workflow", operation, signal);
  expect(approvals.view()).toBeTruthy();
  approvals.cancel();
  expect(await again).toBe("cancelled");
  expect(new OperationApprovals().view()).toBeUndefined();
});
it("an expired flow decision grants nothing and aborted operations never inherit a grant", async () => {
  vi.useFakeTimers();
  const approvals = new OperationApprovals(100);
  const controller = new AbortController();
  const first = approvals.ask("workflow", operation, controller.signal);
  const pending = approvals.view()!;
  vi.setSystemTime(pending.expiresAt);
  approvals.decide("workflow", pending.approvalId, pending.digest, true, true);
  expect(await first).toBe("expired");
  const second = approvals.ask("workflow", operation, controller.signal);
  expect(approvals.view()).toBeTruthy();
  approvals.cancel();
  expect(await second).toBe("cancelled");
  approvals.allowFlow("workflow", operation.cwd);
  controller.abort();
  expect(await approvals.ask("workflow", operation, controller.signal)).toBe(
    "cancelled",
  );
});
afterEach(() => vi.useRealTimers());
it.each([true, false])(
  "consumes a matching decision once (%s)",
  async (allow) => {
    const approvals = new OperationApprovals();
    const result = approvals.ask(
      "workflow",
      operation,
      new AbortController().signal,
    );
    const pending = approvals.view()!;
    approvals.decide("workflow", pending.approvalId, pending.digest, allow);
    approvals.decide("workflow", pending.approvalId, pending.digest, !allow);
    expect(await result).toBe(allow || "declined");
    expect(approvals.view()).toBeUndefined();
  },
);
it("rejects duplicates, changed contents and cross-session responses", async () => {
  const approvals = new OperationApprovals();
  const controller = new AbortController();
  const result = approvals.ask("workflow", operation, controller.signal);
  const pending = approvals.view()!;
  expect(await approvals.ask("workflow", operation, controller.signal)).toBe(
    "cancelled",
  );
  approvals.decide("other", pending.approvalId, pending.digest, true);
  approvals.decide("workflow", pending.approvalId, "changed", true);
  expect(approvals.view()).toEqual(pending);
  controller.abort();
  approvals.decide("workflow", pending.approvalId, pending.digest, true);
  expect(await result).toBe("cancelled");
});
it("expires and rejects late replies; a new service cannot restore grants", async () => {
  vi.useFakeTimers();
  const approvals = new OperationApprovals(100);
  const result = approvals.ask(
    "workflow",
    operation,
    new AbortController().signal,
  );
  const pending = approvals.view()!;
  await vi.advanceTimersByTimeAsync(100);
  approvals.decide("workflow", pending.approvalId, pending.digest, true);
  expect(await result).toBe("expired");
  const restarted = new OperationApprovals();
  restarted.decide("workflow", pending.approvalId, pending.digest, true);
  expect(restarted.view()).toBeUndefined();
});
it("rejects cancellation, malformed input and expired decision without timer delivery", async () => {
  vi.useFakeTimers();
  const approvals = new OperationApprovals(100);
  expect(
    await approvals.ask("workflow", {}, new AbortController().signal),
  ).toBe("cancelled");
  const result = approvals.ask(
    "workflow",
    operation,
    new AbortController().signal,
  );
  const pending = approvals.view()!;
  vi.setSystemTime(pending.expiresAt);
  approvals.decide("workflow", pending.approvalId, pending.digest, true);
  expect(await result).toBe("expired");
  const next = approvals.ask(
    "workflow",
    operation,
    new AbortController().signal,
  );
  approvals.cancel();
  expect(await next).toBe("cancelled");
});
it("gives a person ten minutes by default", async () => {
  vi.useFakeTimers();
  expect(OPERATION_APPROVAL_MS).toBe(600000);
  const approvals = new OperationApprovals();
  const result = approvals.ask(
    "workflow",
    operation,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(OPERATION_APPROVAL_MS - 1000);
  const pending = approvals.view()!;
  approvals.decide("workflow", pending.approvalId, pending.digest, true);
  expect(await result).toBe(true);
  const late = approvals.ask(
    "workflow",
    operation,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(OPERATION_APPROVAL_MS);
  expect(await late).toBe("expired");
  expect(approvals.view()).toBeUndefined();
});

it("keeps native thread identity separate and binds decisions/flow grants to the app conversation", async () => {
  const approvals = new OperationApprovals();
  const signal = new AbortController().signal;
  const first = approvals.ask("workflow", operation, signal, "chat-a");
  const pending = approvals.view()!;
  expect(pending.sessionId).toBe("session");
  expect(pending.conversationSessionId).toBe("chat-a");
  approvals.decide(
    "workflow",
    pending.approvalId,
    pending.digest,
    true,
    true,
    "chat-b",
  );
  expect(approvals.view()).toEqual(pending);
  approvals.decide(
    "workflow",
    pending.approvalId,
    pending.digest,
    true,
    true,
    "chat-a",
  );
  expect(await first).toBe(true);
  expect(await approvals.ask("workflow", operation, signal, "chat-a")).toBe(
    true,
  );
  const other = approvals.ask("workflow", operation, signal, "chat-b");
  expect(approvals.view()).toBeDefined();
  approvals.cancel();
  expect(await other).toBe("cancelled");
});
it("notification exceptions never alter the approval outcome", async () => {
  const changed = vi.fn(() => {
    throw new Error("notification failure");
  });
  const approvals = new OperationApprovals(600000, changed);
  const result = approvals.ask(
    "workflow",
    operation,
    new AbortController().signal,
  );
  const pending = approvals.view()!;
  approvals.decide("workflow", pending.approvalId, pending.digest, false);
  expect(await result).toBe("declined");
  expect(changed).toHaveBeenCalledTimes(2);
});

it("queues concurrent native requests with expiry starting only when visible", async () => {
  vi.useFakeTimers();
  const approvals = new OperationApprovals(100);
  const signal = new AbortController().signal;
  const first = approvals.ask("workflow", operation, signal, "conversation");
  const original = approvals.view()!;
  const second = approvals.ask(
    "workflow",
    { ...operation, itemId: "other-node" },
    signal,
    "conversation",
  );
  expect(approvals.view()).toEqual(original);
  await vi.advanceTimersByTimeAsync(99);
  approvals.decide(
    "workflow",
    original.approvalId,
    original.digest,
    true,
    false,
    "conversation",
  );
  expect(await first).toBe(true);
  const next = approvals.view()!;
  expect(next.itemId).toBe("other-node");
  expect(next.expiresAt).toBe(Date.now() + 100);
  await vi.advanceTimersByTimeAsync(100);
  expect(await second).toBe("expired");
});
it("aborted queued nodes are removed without cancelling the visible node", async () => {
  const approvals = new OperationApprovals();
  const first = approvals.ask(
    "workflow",
    operation,
    new AbortController().signal,
  );
  const pending = approvals.view()!;
  const queued = new AbortController();
  const second = approvals.ask(
    "workflow",
    { ...operation, itemId: "other" },
    queued.signal,
  );
  queued.abort();
  expect(await second).toBe("cancelled");
  expect(approvals.view()).toEqual(pending);
  approvals.cancel();
  expect(await first).toBe("cancelled");
});
const harnessWorkflow = "22222222-2222-4222-8222-222222222222";
const harness = () => ({
  workflowId: harnessWorkflow,
  requestId: operation.requestId,
  digest: "a".repeat(64),
  cwd: "/isolated/integration",
  testFiles: ["add.test.mjs"],
  program: process.execPath,
  args: ["--test", "--test-reporter=tap", "add.test.mjs"],
  command: harnessTestCommand(process.execPath, [
    "--test",
    "--test-reporter=tap",
    "add.test.mjs",
  ]),
  reason: "Independent validation",
});
it("harness tests ignore flow grants and require exact conversation one-use approval", async () => {
  const approvals = new OperationApprovals();
  const input = harness();
  approvals.allowFlow(harnessWorkflow, input.cwd, "conversation");
  const result = approvals.askHarnessTest(
    harnessWorkflow,
    input,
    new AbortController().signal,
    "conversation",
  );
  const pending = approvals.view()!;
  expect(pending.source).toBe("harness-test");
  expect(pending.sessionId).toBeUndefined();
  if (pending.source !== "harness-test") throw Error("wrong approval kind");
  expect(pending.testSpecDigest).toBe(input.digest);
  approvals.decide(
    harnessWorkflow,
    pending.approvalId,
    pending.digest,
    true,
    false,
    "other",
  );
  expect(approvals.view()).toEqual(pending);
  approvals.decide(
    harnessWorkflow,
    pending.approvalId,
    pending.digest,
    true,
    false,
    "conversation",
  );
  expect(await result).toBe(true);
  expect(approvals.view()).toBeUndefined();
  const next = approvals.askHarnessTest(
    harnessWorkflow,
    { ...input, requestId: "33333333-3333-4333-8333-333333333333" },
    new AbortController().signal,
    "conversation",
  );
  expect(approvals.view()).toBeTruthy();
  approvals.cancel();
  expect(await next).toBe("cancelled");
});
it("harness schema rejects flag injection, shell changes, native identities and non-Node commands", () => {
  expect(harnessTestSchema.safeParse(harness()).success).toBe(true);
  for (const patch of [
    { testFiles: ["--eval=bad.test.mjs"] },
    { command: "node hacked" },
    { sessionId: "fake-thread" },
    { program: "/bin/sh" },
    { args: ["--eval", "bad"] },
  ]) {
    expect(
      harnessTestSchema.safeParse({ ...harness(), ...patch }).success,
    ).toBe(false);
  }
});
