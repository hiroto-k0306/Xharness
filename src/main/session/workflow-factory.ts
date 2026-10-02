// セッションのタスク段階(§20)を動かす WorkflowRuntime を、controller の状態とつないで作る。
import { childNeedsAsk } from "../agents/permissions.js";
import { type loadAgentConfig } from "../agents/definitions.js";
import { Router } from "../core/router.js";
import { type Message } from "../core/types.js";
import { projectHookApproval } from "../hooks/shell-hooks.js";
import { shellSearchTools } from "../tools/shell-search.js";
import { webTools } from "../tools/web.js";
import { WorkflowRuntime } from "../workflow/runtime.js";
import { waveChecks } from "../workflow/wave-checks.js";
import { itemsFromMessages } from "./transcript.js";
import { type StoredSession } from "./store.js";
import { type PermissionGate } from "./permission-gate.js";
import { type TurnEvents, updateQuota } from "./turn-events.js";
import {
  defaultTools,
  safeInput,
  toReceipt,
  type ControllerContext,
  type Runtime,
} from "./context.js";

type AgentConfig = Awaited<ReturnType<typeof loadAgentConfig>>;

/** 段階が終わっていれば(または未作成なら)作り直す必要がある */
export function needsNewWorkflow(rt: Runtime): boolean {
  return (
    !rt.workflow ||
    (!rt.workflow.manualReview &&
      ["off", "complete", "attention"].includes(rt.workflow.state.phase))
  );
}

export function createWorkflow(
  ctx: ControllerContext,
  gate: PermissionGate,
  args: {
    session: StoredSession;
    rt: Runtime;
    agentConfig: AgentConfig;
    web?: { enabled: boolean; searchMode: "live" | "cached" };
    events: TurnEvents;
  },
): WorkflowRuntime {
  const { session, rt, agentConfig, web, events } = args;
  const { options } = ctx;
  const emit = options.emit;
  const clean = ctx.clean;
  const sessionId = session.id;
  // プロジェクトのフックは内容が変わるたびに承認を取り直す(§19.10)
  const fingerprint = JSON.stringify(agentConfig.hooks ?? []);
  const approveHooks =
    rt.hookApproval?.fingerprint === fingerprint
      ? rt.hookApproval.approve
      : projectHookApproval(agentConfig.hooks ?? [], (hooks, signal) =>
          gate.ask({
            session,
            rt,
            call: { name: "ProjectHooks", input: { hooks } },
            signal,
            forceAsk: true,
          }),
        );
  rt.hookApproval = { fingerprint, approve: approveHooks };
  return new WorkflowRuntime({
    approveHooks: (_hooks, signal) => approveHooks(signal),
    home: options.home,
    parentId: sessionId,
    cwd: session.cwd,
    config: agentConfig,
    quota: ctx.quota,
    aliases: rt.mainConfig?.aliases ?? options.aliases,
    router: new Router(
      options.providers ?? [options.provider],
      rt.mainConfig?.fallback ?? options.fallback,
      rt.mainConfig?.aliases ?? options.aliases,
    ),
    createTools: (cwd) => {
      const tools = (options.createTools ?? defaultTools)(
        cwd,
        session.readOnly,
      );
      if (web?.enabled)
        for (const [name, tool] of webTools(
          () => options.provider,
          web.searchMode,
          options.fake,
        ))
          tools.set(name, tool);
      return tools;
    },
    permission: async (call, context, signal) =>
      call.name === "ReportDone"
        ? Promise.resolve(true)
        : gate.ask({
            session: { ...session, cwd: context.cwd },
            rt,
            call,
            signal,
            forceAsk: await childNeedsAsk(call, context),
            agentName: context.name,
            agentId: context.id,
          }),
    approve: (items, notes, warnings, signal) =>
      gate.ask({
        session,
        rt,
        call: { name: "SubmitPlan", input: { items, notes, warnings } },
        signal,
        forceAsk: true,
      }),
    onStatus: (context, model, status) =>
      emit({
        type: "agent",
        sessionId,
        agentId: context.id,
        name: context.name,
        model,
        status,
        branch: context.branch,
      }),
    onTranscript: (context, messages) =>
      emit({
        type: "agent_transcript",
        sessionId,
        agentId: context.id,
        items: itemsFromMessages(safeInput(messages, clean) as Message[]),
      }),
    onEvent: (context, event) => {
      if (event.type === "text_delta")
        emit({
          type: "agent_text",
          sessionId,
          agentId: context.id,
          text: clean(event.text),
        });
      if (event.type === "receipt") {
        if (event.receipt.provider === "hook" && !event.receipt.tool) return;
        const receipt = toReceipt(
          event.receipt,
          sessionId,
          events.nextReceiptId(),
        );
        receipt.agentId = context.id;
        receipt.input = safeInput(receipt.input, clean);
        receipt.output = clean(receipt.output ?? "");
        receipt.summary = context.name + " · " + clean(receipt.summary);
        events.record(receipt);
      }
      if (event.type === "step")
        emit({
          type: "agent_step",
          sessionId,
          agentId: context.id,
          step: event.step,
          round: event.round,
        });
      if (event.type === "usage") {
        updateQuota(ctx, event);
        emit({ ...event });
      }
    },
    onPhase: (workflow) => {
      emit({ type: "workflow", sessionId, ...workflow });
      if (["complete", "attention"].includes(workflow.phase))
        emit({
          type: "notice",
          sessionId,
          tone: workflow.phase === "complete" ? "dim" : "warn",
          message: clean(
            (workflow.phase === "complete"
              ? "レビュー完了。修正必須の指摘はありません。"
              : "レビューの往復上限に達しました。残る必須指摘を確認してください。") +
              workflow.findings
                .map(
                  (f) =>
                    `\n${f.severity}: ${f.file}${f.line ? `:${f.line}` : ""} — ${f.message}`,
                )
                .join(""),
          ),
        });
    },
    redact: clean,
    waveChecks: waveChecks(
      agentConfig.waveChecks,
      shellSearchTools(session.cwd).get("Bash")!,
      (_hooks, signal) => approveHooks(signal),
      (hook, output, ok, durationMs) =>
        events.record({
          id: events.nextReceiptId(),
          sessionId,
          ts: Date.now(),
          provider: "harness",
          kind: "tool",
          tool: "WaveCheck",
          decision: ok ? "allow" : "deny",
          durationMs,
          summary: `WaveCheck ${hook.id}: ${ok ? "passed" : "failed"}`,
          input: safeInput(hook, clean),
          output: clean(output),
        }),
    ),
  });
}
