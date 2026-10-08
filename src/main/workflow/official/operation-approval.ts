import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";

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
/** Why an operation request ended without a grant, recorded as the stop reason. */
export type OperationOutcome = true | "declined" | "expired" | "cancelled";
/** Long enough for a person to read the request; the phase timer pauses meanwhile. */
export const OPERATION_APPROVAL_MS = 600000;
export interface PendingOperation extends Operation {
  workflowId: string;
  approvalId: string;
  digest: string;
  expiresAt: number;
}
/** Ephemeral grants: never loaded from disk and consumed exactly once. */
export class OperationApprovals {
  private flow?: { workflowId: string; cwd: string };
  /** Main grants only after the plan is approved; never serialized. */
  allowFlow(workflowId: string, cwd: string) {
    this.flow = { workflowId, cwd };
  }
  private waiting?: {
    view: PendingOperation;
    finish: (outcome: OperationOutcome) => void;
  };
  constructor(private durationMs = OPERATION_APPROVAL_MS) {}
  view() {
    return this.waiting ? structuredClone(this.waiting.view) : undefined;
  }
  ask(
    workflowId: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<OperationOutcome> {
    const parsed = operationSchema.safeParse(input);
    if (!parsed.success || signal.aborted || this.waiting)
      return Promise.resolve("cancelled");
    const operation = structuredClone(parsed.data);
    if (this.flow?.workflowId === workflowId && this.flow.cwd === operation.cwd)
      return Promise.resolve(true);
    const digest = createHash("sha256")
      .update(JSON.stringify([workflowId, operation]))
      .digest("hex");
    return new Promise((accept) => {
      let settled = false;
      const finish = (outcome: OperationOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        this.waiting = undefined;
        accept(signal.aborted ? "cancelled" : outcome);
      };
      const cancel = () => finish("cancelled");
      const timer = setTimeout(() => finish("expired"), this.durationMs);
      this.waiting = {
        view: {
          ...operation,
          workflowId,
          approvalId: randomUUID(),
          digest,
          expiresAt: Date.now() + this.durationMs,
        },
        finish,
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
  decide(
    workflowId: string,
    approvalId: string,
    digest: string,
    allow: boolean,
    flow = false,
  ) {
    const pending = this.waiting;
    if (
      !pending ||
      pending.view.workflowId !== workflowId ||
      pending.view.approvalId !== approvalId ||
      pending.view.digest !== digest
    )
      return;
    if (allow && flow && Date.now() < pending.view.expiresAt)
      this.allowFlow(workflowId, pending.view.cwd);
    pending.finish(
      Date.now() >= pending.view.expiresAt ? "expired" : allow || "declined",
    );
  }
  cancel() {
    this.flow = undefined;
    this.waiting?.finish("cancelled");
  }
}
