import { afterEach, expect, it, vi } from "vitest";
import { OperationApprovals } from "./operation-approval.js";
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
    expect(await result).toBe(allow);
    expect(approvals.view()).toBeUndefined();
  },
);
it("rejects duplicates, changed contents and cross-session responses", async () => {
  const approvals = new OperationApprovals();
  const controller = new AbortController();
  const result = approvals.ask("workflow", operation, controller.signal);
  const pending = approvals.view()!;
  expect(await approvals.ask("workflow", operation, controller.signal)).toBe(
    false,
  );
  approvals.decide("other", pending.approvalId, pending.digest, true);
  approvals.decide("workflow", pending.approvalId, "changed", true);
  expect(approvals.view()).toEqual(pending);
  controller.abort();
  approvals.decide("workflow", pending.approvalId, pending.digest, true);
  expect(await result).toBe(false);
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
  expect(await result).toBe(false);
  const restarted = new OperationApprovals();
  restarted.decide("workflow", pending.approvalId, pending.digest, true);
  expect(restarted.view()).toBeUndefined();
});
it("rejects cancellation, malformed input and expired decision without timer delivery", async () => {
  vi.useFakeTimers();
  const approvals = new OperationApprovals(100);
  expect(
    await approvals.ask("workflow", {}, new AbortController().signal),
  ).toBe(false);
  const result = approvals.ask(
    "workflow",
    operation,
    new AbortController().signal,
  );
  const pending = approvals.view()!;
  vi.setSystemTime(pending.expiresAt);
  approvals.decide("workflow", pending.approvalId, pending.digest, true);
  expect(await result).toBe(false);
  const next = approvals.ask(
    "workflow",
    operation,
    new AbortController().signal,
  );
  approvals.cancel();
  expect(await next).toBe(false);
});
