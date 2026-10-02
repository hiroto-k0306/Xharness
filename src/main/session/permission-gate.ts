// 権限確認(§9, STEP 4 gate)。ルールで決まらなければ画面に尋ね、答えを待つ。
import { randomUUID } from "node:crypto";
import { resolveModel } from "../config/config.js";
import { saveRule } from "../config/project.js";
import { decidePermission, grantFor } from "../core/permissions.js";
import { type PlanItem } from "../workflow/plan-validate.js";
import { type PermissionDecision } from "../../shared/ipc.js";
import { summarizeInput } from "../../shared/summary.js";
import { type StoredSession } from "./store.js";
import { safeInput, type ControllerContext, type Runtime } from "./context.js";

export interface PermissionRequest {
  session: StoredSession;
  rt: Runtime;
  call: { name: string; input: unknown };
  receiptId?: string;
  signal: AbortSignal;
  /** ルールで allow でも必ず尋ねる(計画の承認・フックの承認・子エージェントの書き込みなど) */
  forceAsk?: boolean;
  agentName?: string;
  agentId?: string;
}

export class PermissionGate {
  constructor(private readonly ctx: ControllerContext) {}

  /** 1つのセッションの確認は順番に1件ずつ出す(画面の確認欄は1つ) */
  async ask(request: PermissionRequest): Promise<boolean> {
    const { rt, signal } = request;
    const previous = rt.permissionTail ?? Promise.resolve();
    let release!: () => void;
    rt.permissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      if (signal.aborted) return false;
      return await this.askNow(request);
    } finally {
      release();
    }
  }

  private async askNow({
    session,
    rt,
    call,
    receiptId,
    signal,
    forceAsk = false,
    agentName,
    agentId,
  }: PermissionRequest): Promise<boolean> {
    const { ctx } = this;
    const fullCall = { ...call, id: "permission" };
    rt.asked = false;
    if (rt.config) {
      const latest = ctx.sessions.get(session.id) ?? session;
      const decision = await decidePermission(
        fullCall,
        {
          ...rt.config.permissions,
          mode: latest.permissionMode ?? rt.config.permissions.mode,
        },
        session.cwd,
        {
          readOnly: latest.readOnly,
          scratch: !latest.workspaceId,
          sessionRules: rt.sessionRules,
        },
      );
      if (decision === "deny") return false;
      if (decision === "allow" && !forceAsk) return true;
    } else if (!forceAsk && rt.always.has(call.name)) return true;
    const requestId = randomUUID().slice(0, 8);
    rt.asked = true;
    rt.status = "ask";
    ctx.options.emit({
      type: "permission_request",
      agentId,
      ...(call.name === "SubmitPlan"
        ? {
            plan: safeInput(
              (call.input as { items: PlanItem[] }).items.map((item) => ({
                ...item,
                assignee: {
                  ...item.assignee,
                  model:
                    resolveModel(
                      item.assignee.model,
                      rt.mainConfig?.aliases ?? ctx.options.aliases,
                    )?.model ?? item.assignee.model,
                },
              })),
              ctx.clean,
            ) as unknown[],
          }
        : {}),
      sessionId: session.id,
      requestId,
      receiptId,
      tool: call.name,
      summary:
        (agentName ? `${agentName} · ` : "") +
        (["SubmitPlan", "ProjectHooks"].includes(call.name)
          ? ctx.clean(JSON.stringify(call.input))
          : summarizeInput(call.name, call.input, ctx.clean, 300)),
    });
    void ctx.emitState();
    const decision = await new Promise<PermissionDecision>(
      (resolveDecision) => {
        const done = (d: PermissionDecision) => {
          signal.removeEventListener("abort", onAbort);
          rt.pending = undefined;
          resolveDecision(d);
        };
        const onAbort = () => done("deny");
        rt.pending = {
          requestId,
          resolve: done,
          ...(call.name === "SubmitPlan"
            ? { plan: (call.input as { items: PlanItem[] }).items }
            : {}),
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      },
    );
    rt.status = "running";
    if (forceAsk) {
      /* Approval is always per request; never persist it. */
    } else if (decision === "always" && rt.config) {
      const grant = grantFor({
        ...fullCall,
        input: safeInput(fullCall.input, ctx.clean),
      });
      await saveRule(ctx.options.home, grant);
      rt.config.permissions.rules.push(grant);
    } else if (decision === "session" && rt.config)
      (rt.sessionRules ??= []).push(grantFor(fullCall));
    else if (decision === "always" || decision === "session")
      rt.always.add(call.name);
    ctx.options.emit({
      type: "permission_resolved",
      sessionId: session.id,
      requestId,
      decision,
    });
    void ctx.emitState();
    return decision !== "deny";
  }
}
