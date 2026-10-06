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
export interface PendingOperation extends Operation {
  workflowId: string;
  approvalId: string;
  digest: string;
  expiresAt: number;
}
/** Ephemeral grants: never loaded from disk and consumed exactly once. */
export class OperationApprovals {
  private waiting?: { view: PendingOperation; finish: (yes: boolean) => void };
  constructor(private durationMs = 60000) {}
  view() {
    return this.waiting ? structuredClone(this.waiting.view) : undefined;
  }
  ask(
    workflowId: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<boolean> {
    const parsed = operationSchema.safeParse(input);
    if (!parsed.success || signal.aborted || this.waiting)
      return Promise.resolve(false);
    const operation = structuredClone(parsed.data);
    const digest = createHash("sha256")
      .update(JSON.stringify([workflowId, operation]))
      .digest("hex");
    return new Promise((accept) => {
      let settled = false;
      const finish = (yes: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        this.waiting = undefined;
        accept(yes && !signal.aborted);
      };
      const cancel = () => finish(false);
      const timer = setTimeout(cancel, this.durationMs);
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
  ) {
    const pending = this.waiting;
    if (
      !pending ||
      pending.view.workflowId !== workflowId ||
      pending.view.approvalId !== approvalId ||
      pending.view.digest !== digest
    )
      return;
    pending.finish(allow && Date.now() < pending.view.expiresAt);
  }
  cancel() {
    this.waiting?.finish(false);
  }
}
