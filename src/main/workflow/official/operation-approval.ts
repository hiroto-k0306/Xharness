import { randomUUID, createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { relativeFile } from "./contracts.js";

export const operationSchema = z
  .object({
    requestId: z.string().uuid(),
    sessionId: z.string().min(1).max(200),
    turnId: z.string().min(1).max(200),
    itemId: z.string().min(1).max(200),
    command: z.string().min(1).max(4000),
    cwd: z.string().min(1).max(1000),
    targets: z.array(z.string().min(1).max(1000)).min(1).max(20),
    reason: z.string().max(1000),
  })
  .strict();
export type Operation = z.infer<typeof operationSchema>;
/** Display the executable and exact argv; this text is never executed by a shell. */
export const harnessTestCommand = (program: string, args: readonly string[]) =>
  [program, ...args].map((value) => JSON.stringify(value)).join(" ");
export const harnessTestSchema = z
  .object({
    workflowId: z.string().uuid(),
    requestId: z.string().uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    cwd: z.string().min(1).max(1000).refine(isAbsolute),
    testFiles: z
      .array(
        relativeFile.refine(
          (value) =>
            !value.startsWith("-") && /\.test\.(?:js|mjs)$/.test(value),
        ),
      )
      .min(1)
      .max(20),
    command: z.string().min(1).max(4000),
    program: z
      .string()
      .min(1)
      .max(1000)
      .refine(
        (value) =>
          isAbsolute(value) &&
          /^node(?:\.exe)?$/i.test(
            value.replaceAll("\\", "/").split("/").at(-1) ?? "",
          ),
      ),
    args: z.array(z.string().min(1).max(1000)).min(3).max(22),
    reason: z.string().max(1000),
  })
  .strict()
  .refine(
    (value) =>
      JSON.stringify(value.args) ===
        JSON.stringify(["--test", "--test-reporter=tap", ...value.testFiles]) &&
      value.command === harnessTestCommand(value.program, value.args),
    "independent Node test arguments/command must match",
  );
export type HarnessTestOperation = z.infer<typeof harnessTestSchema>;
export type OperationOutcome = true | "declined" | "expired" | "cancelled";
export const OPERATION_APPROVAL_MS = 600000;
interface ApprovalIdentity {
  workflowId: string;
  conversationSessionId?: string;
  approvalId: string;
  digest: string;
  expiresAt: number;
}
export interface NativePendingOperation extends Operation, ApprovalIdentity {
  source?: "native";
}
export interface HarnessTestPendingOperation extends ApprovalIdentity {
  source: "harness-test";
  requestId: string;
  command: string;
  cwd: string;
  targets: string[];
  reason: string;
  program: string;
  args: string[];
  testFiles: string[];
  testSpecDigest: string;
  /** Native provider identities do not exist for harness-owned processes. */
  sessionId?: never;
  turnId?: never;
  itemId?: never;
}
export type PendingApproval =
  NativePendingOperation | HarnessTestPendingOperation;
/** Compatibility name; new views discriminate native/harness-test with source. */
export type PendingOperation = PendingApproval;
type Entry = {
  view: PendingApproval;
  key: string;
  signal: AbortSignal;
  accept: (value: OperationOutcome) => void;
  cancel: () => void;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
/** Ephemeral, one-use grants. Concurrent nodes queue without bypassing consent. */
export class OperationApprovals {
  private flow?: {
    workflowId: string;
    cwd: string;
    conversationSessionId?: string;
  };
  private waiting?: Entry;
  private queued: Entry[] = [];
  constructor(
    private durationMs = OPERATION_APPROVAL_MS,
    private onChange?: () => void,
  ) {}
  private changed() {
    try {
      this.onChange?.();
    } catch {
      /* Notification errors never change grants. */
    }
  }
  allowFlow(workflowId: string, cwd: string, conversationSessionId?: string) {
    this.flow = { workflowId, cwd, conversationSessionId };
  }
  view() {
    return this.waiting ? structuredClone(this.waiting.view) : undefined;
  }
  private startNext() {
    if (this.waiting) return;
    const next = this.queued.shift();
    if (!next) return;
    if (next.signal.aborted) {
      this.finish(next, "cancelled");
      return;
    }
    this.waiting = next;
    next.view.expiresAt = Date.now() + this.durationMs;
    next.timer = setTimeout(
      () => this.finish(next, "expired"),
      this.durationMs,
    );
    this.changed();
  }
  private finish(entry: Entry, outcome: OperationOutcome) {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.signal.removeEventListener("abort", entry.cancel);
    this.queued = this.queued.filter((item) => item !== entry);
    const active = this.waiting === entry;
    if (active) this.waiting = undefined;
    entry.accept(entry.signal.aborted ? "cancelled" : outcome);
    if (active) this.changed();
    this.startNext();
  }
  private enqueue(
    view: PendingApproval,
    key: string,
    signal: AbortSignal,
  ): Promise<OperationOutcome> {
    if (
      signal.aborted ||
      this.waiting?.key === key ||
      this.queued.some((item) => item.key === key) ||
      this.queued.length >= 64
    )
      return Promise.resolve("cancelled");
    return new Promise((accept) => {
      const entry: Entry = {
        view,
        key,
        signal,
        accept,
        cancel: () => {},
        settled: false,
      };
      entry.cancel = () => this.finish(entry, "cancelled");
      this.queued.push(entry);
      signal.addEventListener("abort", entry.cancel, { once: true });
      if (signal.aborted) entry.cancel();
      else this.startNext();
    });
  }
  ask(
    workflowId: string,
    input: unknown,
    signal: AbortSignal,
    conversationSessionId?: string,
  ): Promise<OperationOutcome> {
    const parsed = operationSchema.safeParse(input);
    if (!parsed.success || signal.aborted) return Promise.resolve("cancelled");
    const operation = structuredClone(parsed.data);
    if (
      this.flow?.workflowId === workflowId &&
      this.flow.cwd === operation.cwd &&
      this.flow.conversationSessionId === conversationSessionId
    )
      return Promise.resolve(true);
    const digest = createHash("sha256")
      .update(JSON.stringify([workflowId, operation]))
      .digest("hex");
    return this.enqueue(
      {
        ...operation,
        source: "native",
        workflowId,
        conversationSessionId,
        approvalId: randomUUID(),
        digest,
        expiresAt: 0,
      },
      JSON.stringify([
        workflowId,
        "native",
        operation.requestId,
        operation.sessionId,
        operation.turnId,
        operation.itemId,
      ]),
      signal,
    );
  }
  askHarnessTest(
    workflowId: string,
    input: unknown,
    signal: AbortSignal,
    conversationSessionId?: string,
  ): Promise<OperationOutcome> {
    const parsed = harnessTestSchema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.workflowId !== workflowId ||
      signal.aborted
    )
      return Promise.resolve("cancelled");
    const operation = structuredClone(parsed.data);
    // Independent validation always asks explicitly; neither auto nor flow can grant it.
    const digest = createHash("sha256")
      .update(JSON.stringify([workflowId, "harness-test", operation]))
      .digest("hex");
    return this.enqueue(
      {
        source: "harness-test",
        workflowId,
        conversationSessionId,
        requestId: operation.requestId,
        approvalId: randomUUID(),
        digest,
        expiresAt: 0,
        command: operation.command,
        cwd: operation.cwd,
        targets: operation.testFiles,
        reason: operation.reason,
        program: operation.program,
        args: operation.args,
        testFiles: operation.testFiles,
        testSpecDigest: operation.digest,
      },
      JSON.stringify([workflowId, "harness-test", operation.requestId]),
      signal,
    );
  }
  decide(
    workflowId: string,
    approvalId: string,
    digest: string,
    allow: boolean,
    flow = false,
    conversationSessionId?: string,
  ) {
    const pending = this.waiting;
    if (
      !pending ||
      pending.view.workflowId !== workflowId ||
      pending.view.approvalId !== approvalId ||
      pending.view.digest !== digest ||
      pending.view.conversationSessionId !== conversationSessionId
    )
      return;
    if (
      allow &&
      flow &&
      pending.view.source !== "harness-test" &&
      Date.now() < pending.view.expiresAt
    )
      this.allowFlow(
        workflowId,
        pending.view.cwd,
        pending.view.conversationSessionId,
      );
    this.finish(
      pending,
      Date.now() >= pending.view.expiresAt ? "expired" : allow || "declined",
    );
  }
  cancel() {
    this.flow = undefined;
    const pending = [...(this.waiting ? [this.waiting] : []), ...this.queued];
    this.waiting = undefined;
    this.queued = [];
    for (const entry of pending) this.finish(entry, "cancelled");
    this.changed();
  }
}
