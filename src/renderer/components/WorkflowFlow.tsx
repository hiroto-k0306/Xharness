import { useEffect, useState } from "react";
import type { OfficialWorkflowView } from "../../shared/official-workflow.js";
import type { WorkflowRecord } from "../../main/workflow/official/runtime.js";
import styles from "./Activity.module.css";

const endings: Record<string, string> = {
  completed: "完了",
  failed: "失敗",
  cancelled: "取消",
  interrupted: "中断",
  attention: "要確認",
  "quota-paused": "利用枠待ち",
};
const toolStatus = {
  requested: "要求",
  allowed: "許可",
  denied: "拒否",
  completed: "実行完了",
  failed: "実行失敗",
};
type Phase = WorkflowRecord["calls"][number]["phase"];

/** Read saved native state; never infer the SDK's internal six-step loop. */
export function WorkflowFlow({
  sessionId,
  running,
  scopeRequired,
  enabled,
}: {
  sessionId?: string;
  running: boolean;
  scopeRequired: boolean;
  enabled: boolean;
}) {
  const [snapshot, setSnapshot] = useState<OfficialWorkflowView>();
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!enabled || !sessionId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await window.harness.officialWorkflow?.({
          action: "list",
        });
        if (live) {
          setSnapshot(result);
          setError(!result);
        }
      } catch {
        if (live) setError(true);
      } finally {
        if (live) timer = setTimeout(() => void poll(), 500);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sessionId, enabled]);
  const latest = snapshot?.records.find(
    ({ record }) => record.sessionId === sessionId,
  )?.record;
  // A new submission must not look completed while its first record is being prepared.
  const record = running && latest?.finishedAt ? undefined : latest;
  const operation =
    snapshot?.operationApproval?.workflowId === record?.id
      ? snapshot?.operationApproval
      : undefined;
  const phase =
    record?.status === "implementing"
      ? "implement"
      : record?.status === "verifying"
        ? "verify"
        : record?.status === "reviewing"
          ? "review"
          : record?.status === "approval"
            ? "approval"
            : record?.status === "planning"
              ? record.next === "complete"
                ? "conversation"
                : "plan"
              : undefined;
  const request = (phases: Phase[]) =>
    record?.calls.filter((c) => phases.includes(c.phase)).at(-1);
  const callState = (phases: Phase[]) => {
    const call = request(phases);
    return !call
      ? "未記録"
      : call.status === "running"
        ? "要求準備・応答待ち"
        : call.status === "completed"
          ? "応答取得"
          : (endings[call.status] ?? call.status);
  };
  const actor = (phases: Phase[]) => {
    const call = request(phases);
    return call
      ? `要求先: ${call.provider === "claude" ? "Claude" : "Codex"} · ${call.requestedModel}`
      : "モデル未記録";
  };
  const color = (phases: Phase[]) =>
    request(phases)?.provider === "codex" ? "var(--codex)" : "var(--claude)";
  const tests = record?.checks.at(-1)?.tests;
  const stopped = !!record && !!endings[record.status];
  const nodes = [
    {
      id: "conversation",
      title: "質問・作業の判別 / 回答",
      actor: actor(["conversation"]),
      status: callState(["conversation"]),
      color: color(["conversation"]),
    },
    {
      id: "scope",
      title: "対象ファイル・既存テストの確認",
      actor: "利用者 → ハーネス",
      status: scopeRequired
        ? "対象の確認待ち"
        : record?.project
          ? "対象指定済み"
          : "未記録 / 質問では不要",
    },
    {
      id: "plan",
      title: "計画",
      actor: actor(["plan"]),
      status: callState(["plan"]),
      color: color(["plan"]),
    },
    {
      id: "approval",
      title: "計画の検証・承認",
      actor: "ハーネスが検証 / 利用者が承認",
      status: record?.approvedDigest
        ? "承認記録あり"
        : record?.status === "approval"
          ? "計画の承認待ち"
          : "未記録",
    },
    {
      id: "implement",
      title: "実装・修正",
      actor: actor(["implement", "fix"]),
      status: operation
        ? "今回の操作の承認待ち"
        : callState(["implement", "fix"]),
      color: color(["implement", "fix"]),
    },
    {
      id: "verify",
      title: "独立テスト",
      actor: "ハーネスがローカルプロセスを実行",
      status:
        phase === "verify"
          ? "テスト工程中"
          : tests?.length
            ? `${tests.filter((t) => t.passed).length}/${tests.length}件 合格`
            : "結果未記録",
    },
    {
      id: "review",
      title: "別会社による差分レビュー",
      actor: actor(["review"]),
      status: callState(["review"]),
      color: color(["review"]),
    },
  ];
  return (
    <aside
      className={`${styles.flow} ${styles.workflowFlow}`}
      aria-label="通常ワークフロー"
    >
      <h2>LoopFlow</h2>
      <p role="status">
        {error
          ? "状態を取得できません。完了や許可とは扱いません。"
          : scopeRequired
            ? "変更対象・テストの確認待ち"
            : record
              ? (endings[record.status] ??
                `現在: ${nodes.find((node) => node.id === phase)?.title ?? "保存状態を確認中"}`)
              : running
                ? "実行準備中 / 状態の取得待ち"
                : "この会話の実行記録は未取得です"}
      </p>
      {record?.simulated && <p>模擬通信の記録</p>}
      <p>
        モデルは指示・返答を生成。ツールは公式SDK / App
        Server、独立テスト・Git・記録はハーネスが実行します。
      </p>
      <p>
        保存状態を表示します。公式基盤内部の全往復を示すものではありません。
      </p>
      {nodes.map((node) => (
        <div
          key={node.id}
          className={styles.node}
          aria-current={
            !error &&
            ((!stopped && phase === node.id) ||
              (node.id === "scope" && scopeRequired))
              ? "step"
              : undefined
          }
        >
          <b style={{ color: node.color ?? "var(--text)" }}>{node.title}</b>
          <div>{node.actor}</div>
          <div>{error ? "状態不明" : node.status}</div>
        </div>
      ))}
      <div className={styles.node}>
        <b>公式実行基盤のツール（直近6イベント）</b>
        <div>LLMが要求 / ハーネスが範囲・承認を確認 / 公式基盤が実行</div>
        {record?.tools.slice(-6).map((tool, i) => (
          <div key={`${tool.actionId}-${i}`}>
            {tool.name} · {toolStatus[tool.status]}
          </div>
        ))}
        {!record?.tools.length && (
          <div>ツールイベント未記録（質問はツールなし）</div>
        )}
      </div>
      {record && (
        <div className={styles.node}>
          <b>ハーネスの保存記録</b>
          <div>
            変更commit {record.commits.length}件 / 修正{" "}
            {record.correctionRounds}回 / レビュー結果 {record.reviews.length}件
          </div>
          {record.pendingEffect && (
            <div>確定待ち: {record.pendingEffect.kind}</div>
          )}
          {record.error && <div>停止理由: {record.error}</div>}
        </div>
      )}
    </aside>
  );
}
