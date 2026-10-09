import { useEffect, useRef, useState } from "react";
import type {
  OfficialWorkflowCommand,
  OfficialWorkflowView,
} from "../../shared/official-workflow.js";
import { OfficialPlanAssignments } from "./OfficialPlanAssignments.js";
import styles from "./ChatOfficialApprovals.module.css";

/** Pending grants belong to the saved conversation, never a matching cwd. */
export function ChatOfficialApprovals({
  sessionId,
  focus,
}: {
  sessionId: string;
  focus?: { workflowId?: string; approvalId?: string; sequence: number };
}) {
  const [view, setView] = useState<OfficialWorkflowView>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(Date.now());
  const sending = useRef(false);
  const sent = useRef(new Set<string>());
  const cards = useRef<HTMLDivElement>(null);
  const focusedSequence = useRef<number | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const poll = () =>
      void window.harness
        .officialWorkflow?.({ action: "list" })
        .then((v) => {
          if (live) {
            setView(v);
            setNow(Date.now());
          }
        })
        .catch(() => {
          if (live) setError("承認状態を取得できません");
        });
    poll();
    const timer = setInterval(poll, 500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [sessionId]);
  const approval = view?.approval;
  const plan =
    approval && approval.sessionId === sessionId
      ? view?.records.find(
          ({ record }) =>
            record.id === approval.id &&
            record.sessionId === sessionId &&
            record.status === "approval",
        )?.record
      : undefined;
  const operation = view?.operationApproval;
  const operationRecord =
    operation && operation.conversationSessionId === sessionId
      ? view?.records.find(
          ({ record }) =>
            record.id === operation.workflowId &&
            record.sessionId === sessionId,
        )?.record
      : undefined;
  const send = async (command: OfficialWorkflowCommand, key: string) => {
    const expiresAt =
      command.action === "approve" ? approval?.expiresAt : operation?.expiresAt;
    if (
      !expiresAt ||
      !Number.isFinite(expiresAt) ||
      Date.now() >= expiresAt ||
      sending.current ||
      sent.current.has(key)
    )
      return;
    sending.current = true;
    sent.current.add(key);
    setPending(true);
    setError("");
    try {
      const result = await window.harness.officialWorkflow?.(command);
      if (result) {
        setView(result);
        if (result.error) setError(result.error);
      }
    } catch {
      setError("操作を完了できませんでした。自動再送はしていません。");
    } finally {
      sending.current = false;
      setPending(false);
    }
  };
  useEffect(() => {
    if (!focus || focusedSequence.current === focus.sequence) return;
    const card = Array.from(
      cards.current?.querySelectorAll<HTMLElement>("[data-approval-id]") ?? [],
    ).find(
      (node) =>
        (!focus.workflowId || node.dataset.workflowId === focus.workflowId) &&
        (!focus.approvalId || node.dataset.approvalId === focus.approvalId),
    );
    if (card) {
      focusedSequence.current = focus.sequence;
      card.scrollIntoView?.({ block: "nearest" });
      card.focus();
    }
  }, [focus, view]);
  return (
    <div ref={cards} className={styles.cards}>
      {error && <p role="alert">{error}</p>}
      {plan?.plan && approval && (
        <section
          role="alertdialog"
          aria-label="この会話の計画承認"
          tabIndex={-1}
          data-workflow-id={plan.id}
          data-approval-id={approval.approvalId}
          className={styles.card}
        >
          <h3>計画を確認してください</h3>
          <p>{plan.goal}</p>
          <p>{plan.plan.summary}</p>
          <p>
            会話：{sessionId} / workflow：{plan.id} / 承認ID：
            {approval.approvalId}
          </p>
          <p>作業場所：{plan.cwd}</p>
          <p>承認digest：{approval.digest}</p>
          <p>期限：{new Date(approval.expiresAt).toLocaleString()}</p>
          <p>
            {approval.autoOperations
              ? "計画承認後、このフローの操作を自動許可します。禁止操作と作業範囲の検査は維持します。"
              : "操作は個別確認します。通常作業では、このフローのみ許可も選べます。"}
          </p>
          {plan.nativeWork && (
            <p>
              選択中の作業場所を直接編集します。既存変更を保全し、自動commit・reset・mergeは行いません。検証結果はモデルの実行報告です。
            </p>
          )}
          {plan.plan.tasks.map((task) => (
            <article key={task.id}>
              <h4>{task.title}</h4>
              <p>{task.instructions}</p>
              <p>
                変更候補：{task.files.join(", ")} / 検証：
                {task.acceptance.join(", ")} / 依存：
                {task.dependsOn.join(", ") || "なし"}
              </p>
              <OfficialPlanAssignments record={plan} task={task} />
            </article>
          ))}
          <details>
            <summary>保存された計画・作業範囲・設定の全内容</summary>
            <pre>
              {JSON.stringify(
                {
                  plan: plan.plan,
                  project: plan.project,
                  nativeWork: plan.nativeWork,
                  base: plan.base,
                  head: plan.head,
                  injection: plan.injection,
                },
                null,
                2,
              )}
            </pre>
          </details>
          {now >= approval.expiresAt && <p>期限切れです。承認できません。</p>}
          {[true, false].map((allow) => (
            <button
              key={String(allow)}
              disabled={
                pending ||
                now >= approval.expiresAt ||
                sent.current.has(approval.approvalId)
              }
              onClick={() =>
                void send(
                  {
                    action: "approve",
                    id: plan.id,
                    approvalId: approval.approvalId,
                    digest: approval.digest,
                    sessionId,
                    allow,
                  },
                  approval.approvalId,
                )
              }
            >
              {allow ? "この計画を承認" : "計画を拒否"}
            </button>
          ))}
        </section>
      )}
      {operationRecord && operation && (
        <section
          role="alertdialog"
          aria-label="今回の操作の承認"
          tabIndex={-1}
          data-workflow-id={operation.workflowId}
          data-approval-id={operation.approvalId}
          className={styles.card}
        >
          <h3>操作の許可が必要です</h3>
          <p>操作：{operation.command}</p>
          <p>対象：{operation.targets.join(", ")}</p>
          <p>作業場所：{operation.cwd}</p>
          <p>要求理由：{operation.reason}</p>
          <p>
            会話：{sessionId} / workflow：{operation.workflowId} / request：
            {operation.requestId} / 承認ID：{operation.approvalId}
          </p>
          <p>承認digest：{operation.digest}</p>
          <p>期限：{new Date(operation.expiresAt).toLocaleString()}</p>
          <p>
            許可は今回の操作だけです。フロー許可も終了・停止時に失効し、禁止操作は許可しません。期限切れは拒否されます。
          </p>
          {now >= operation.expiresAt && <p>期限切れです。承認できません。</p>}
          {[
            true,
            false,
            ...(operationRecord.nativeWork ? ["flow" as const] : []),
          ].map((allow) => (
            <button
              key={String(allow)}
              disabled={
                pending ||
                now >= operation.expiresAt ||
                sent.current.has(operation.approvalId)
              }
              onClick={() =>
                void send(
                  {
                    action: "tool_decision",
                    id: operation.workflowId,
                    approvalId: operation.approvalId,
                    digest: operation.digest,
                    sessionId,
                    allow: allow !== false,
                    ...(allow === "flow" ? { scope: "flow" as const } : {}),
                  },
                  operation.approvalId,
                )
              }
            >
              {allow === "flow"
                ? "このフローのみ許可"
                : allow
                  ? "今回の操作だけ許可"
                  : "拒否"}
            </button>
          ))}
        </section>
      )}
    </div>
  );
}
