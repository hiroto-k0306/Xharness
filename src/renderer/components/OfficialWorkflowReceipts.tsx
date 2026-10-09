import { OfficialPlanPolicy } from "./OfficialPlanPolicy.js";
import { useEffect, useRef, useState } from "react";
import type {
  OfficialWorkflowCommand,
  OfficialWorkflowView,
} from "../../shared/official-workflow.js";
import { OfficialModelEvidence } from "./OfficialModelEvidence.js";
import { ModelSelectionEvidence } from "./ModelSelectionEvidence.js";
import { OfficialSkillEvidence } from "./OfficialSkillEvidence.js";
import { OfficialCommunication } from "./OfficialCommunication.js";
import { OfficialPlanAssignments } from "./OfficialPlanAssignments.js";
import { officialFailureMessage } from "../../main/workflow/official/session-result.js";
export function OfficialWorkflowReceipts({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<OfficialWorkflowView>();
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const sending = useRef(false);
  useEffect(() => {
    let live = true;
    const poll = () =>
      void window.harness
        .officialWorkflow?.({ action: "list" })
        .then((v) => {
          if (live) setView(v);
        })
        .catch(() => {
          if (live) setError("保存証跡を取得できません");
        });
    poll();
    const timer = setInterval(poll, 500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [sessionId]);
  const send = async (command: OfficialWorkflowCommand) => {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setError("");
    try {
      const result = await window.harness.officialWorkflow?.(command);
      if (result) setView(result);
    } catch {
      setError("操作を完了できませんでした。自動再送はしていません。");
    } finally {
      sending.current = false;
      setPending(false);
    }
  };
  return (
    <details aria-label="公式workflow receipts">
      <summary>
        公式の計画・検証・レビュー・保存証跡（
        {view?.activeId &&
          view.activeSessionId === sessionId &&
          !view.records.some(({ record }) => record.id === view.activeId) && (
            <p>
              公式接続と作業準備を確認しています。
              <button
                disabled={pending}
                onClick={() =>
                  void send({ action: "cancel", id: view.activeId!, sessionId })
                }
              >
                接続確認を中断
              </button>
            </p>
          )}
        {view?.records.filter(({ record }) => record.sessionId === sessionId)
          .length ?? 0}
        件）
      </summary>
      {error && <p role="alert">{error}</p>}
      {view?.records
        .filter(({ record }) => record.sessionId === sessionId)
        .map(({ record: r, resumeBlocked, reportHref }) => (
          <article key={r.id}>
            <h3>
              {r.status} / 修正 {r.correctionRounds}回
            </h3>
            <a href={reportHref}>HTMLレポートを開く</a>
            <OfficialCommunication record={r} />
            <p>保全した作業領域：{r.cwd}</p>
            <p>{r.goal}</p>
            {r.answer && <p aria-label="公式回答">{r.answer}</p>}
            {r.dag && (
              <div>
                <h4>DAG / 最大2並列 / native会話resume未対応</h4>
                <p>
                  {r.dag.phase} /{" "}
                  {r.simulated ? "模擬実行" : "実provider並行実行は未検証"}
                </p>
                {r.dag.nodes.map((n) => (
                  <p key={n.id}>
                    {n.id}: {n.state} / base {n.base?.slice(0, 12) ?? "未確定"}{" "}
                    / 取込 {n.integratedHead?.slice(0, 12) ?? "未取込"}
                  </p>
                ))}
              </div>
            )}
            <small>
              task {r.id} / 次の段階 {r.next} / 再開 {r.resumed ?? 0}回
            </small>
            <p>
              {r.nativeWork &&
                (r.nativeDagWorkspace?.integration?.head
                  ? "隔離Git worktreeのコミット（利用者ブランチ未変更）："
                  : "ファイル内容の比較digest（Git HEADではありません）：")}
              base {/^0+$/.test(r.base) ? "未測定" : r.base.slice(0, 12)} → head{" "}
              {/^0+$/.test(r.head) ? "未測定" : r.head.slice(0, 12)}
            </p>
            {r.nativeDagWorkspace && (
              <p>
                所有する隔離Git worktrees：source base{" "}
                {r.nativeDagWorkspace.sourceBase.slice(0, 12)} / 統合HEAD{" "}
                {r.nativeDagWorkspace.integration?.head?.slice(0, 12) ??
                  "未取込"}
                。利用者のブランチは変更しません。
              </p>
            )}
            {r.plan && (
              <>
                <h4>確認する計画</h4>
                <p>{r.plan.summary}</p>
                <OfficialPlanPolicy plan={r.plan} />
                {r.nativeWork && (
                  <section aria-label="実案件の承認範囲">
                    <p>
                      公式エージェントに対象探索・編集・テスト選択を任せます。作業場所：
                      {r.cwd}
                      {r.nativeDagWorkspace
                        ? "（所有する隔離Git worktree）。承認済み変更だけをハーネスがcommit・統合し、利用者のブランチへmerge/resetは行いません。"
                        : "（選択中のフォルダー／worktree）。既存の変更を保全し、自動commit・reset・mergeは行いません。"}
                    </p>
                    <p>
                      {r.nativeDagWorkspace
                        ? "ファイル一覧は各taskの承認済み編集範囲です。"
                        : "ファイル一覧は計画時点の候補です。"}
                      公式sandboxを維持します。通常モードでは操作ごとに確認し、「このフローのみ許可」も選べます。追加課金は禁止のままです。
                    </p>
                    {view.approval?.id === r.id &&
                      view.approval.autoOperations && (
                        <p>
                          自動モード：計画承認後、このフローの操作は自動許可します。禁止操作と作業範囲の検査は維持します。
                        </p>
                      )}
                    <p>
                      {r.nativeDagWorkspace
                        ? "各taskのモデル報告と、統合後に別承認で実行する独立プロセステストを分けて記録します。統合レビューで重大指摘があれば停止し、作業領域を保全します。"
                        : "テスト結果はモデルの実行報告です。ハーネスの独立プロセス検証ではありません。別会社レビューと最大2回の修正を行います。"}
                    </p>
                  </section>
                )}
                {r.project && (
                  <section aria-label="実案件の承認範囲">
                    <p>
                      セッションの作業場所：{r.project.source} /
                      {r.project.preparation?.kind === "local-copy"
                        ? "元ファイルの検査digest："
                        : "開始HEAD："}
                      {r.project.sourceHead}
                    </p>
                    <p>
                      変更対象：{r.project.files.join(", ")}
                      。元フォルダーへの反映・mainへのマージは自動で行いません。
                    </p>
                    {r.project.preparation && (
                      <p>
                        作業方式：
                        {r.project.preparation.kind === "local-copy"
                          ? "対象フォルダー内に作業用コピーを作成"
                          : r.project.preparation.kind === "reuse-worktree"
                            ? "管理済みworktreeを再利用"
                            : "専用ブランチのworktreeを作成"}
                        。 作業領域：{r.project.preparation.destination}
                        （新規作成はこの計画の承認後）。
                      </p>
                    )}
                    <p>
                      独立テスト：
                      {r.project.testSetup?.command ??
                        `node --test ${r.project.testFile}`}
                      （既存テストは変更しません）。
                    </p>
                    {r.project.testSetup && (
                      <p>
                        Vitest {r.project.testSetup.version} / 設定：
                        {r.project.testSetup.config ?? "既定"}
                        。設定・依存の指紋を承認に固定します。既存依存{" "}
                        {r.project.testSetup.dependencies.packages.length}
                        パッケージ・{r.project.testSetup.dependencies.files}
                        ファイル（
                        {Math.ceil(
                          r.project.testSetup.dependencies.bytes / 1048576,
                        )}{" "}
                        MiB）を作業領域にコピーし、元のnode_modulesは共有しません。設定ファイル：
                        {r.project.testSetup.settings
                          .map((f) => f.path)
                          .join(", ")}
                      </p>
                    )}
                    {r.project.testSetup && (
                      <details>
                        <summary>コピーする依存のバージョン</summary>
                        <p>
                          {r.project.testSetup.dependencies.packages
                            .map((p) => `${p.name}@${p.version}`)
                            .join(", ")}
                        </p>
                      </details>
                    )}
                    <p>
                      承認すると表示した作業領域で実装・ローカルテスト・別会社レビューを行います。設定・plugin・setup・テストコードのworkspace外の副作用をOSで完全隔離する機能ではありません。依存のインストールや任意shellは実行しません。
                    </p>
                    <p>
                      実行するNodeの実体：
                      {r.project.testProgram ?? "記録なし"}
                      。Xが実行し、モデルにはテストコマンド実行を許可しません。
                    </p>
                  </section>
                )}
                {r.plan.tasks.map((t) => (
                  <div key={t.id}>
                    <strong>{t.title}</strong>
                    <p>{t.instructions}</p>
                    <p>
                      対象 {t.files.join(", ")} /{" "}
                      {r.nativeWork ? "検証方針" : "テスト"}{" "}
                      {t.acceptance.join(", ")} / 依存{" "}
                      {t.dependsOn.join(", ") || "なし"}
                    </p>
                    <OfficialPlanAssignments record={r} task={t} />
                  </div>
                ))}
              </>
            )}
            {view.approval?.id === r.id && (
              <p>承認操作は対応する会話のチャットで行います。</p>
            )}
            {view.activeId === r.id ? (
              <button
                onClick={() =>
                  void send({
                    action: "cancel",
                    id: r.id,
                    sessionId: r.sessionId,
                  })
                }
              >
                workflowを中断
              </button>
            ) : (
              r.status !== "completed" && (
                <>
                  <button
                    disabled={!!resumeBlocked || pending || !!view.activeId}
                    onClick={() => void send({ action: "resume", id: r.id })}
                  >
                    安全な段階から再開
                  </button>
                  {resumeBlocked && (
                    <p>
                      自動再送を停止：{resumeBlocked}
                      。不確定な副作用と作業は保全されています。
                    </p>
                  )}
                </>
              )
            )}
            <h4>
              {r.nativeWork
                ? r.nativeDagWorkspace ||
                  r.nativeWork.validation === "independent-process"
                  ? "独立プロセス検証・モデル報告・別会社レビュー"
                  : "モデルの検証報告と別会社レビュー"
                : "実テストとレビューの証跡"}
            </h4>
            {r.nativeValidation?.map((test, index) => (
              <p key={index}>
                {test.command || "未実行"}: {test.status} / {test.summary}
                （モデル報告）
              </p>
            ))}
            {r.checks.map((c, i) => (
              <p key={i}>
                {c.head.slice(0, 12)}：
                {c.tests
                  .map(
                    (t) =>
                      `${t.id} ${t.passed ? "合格" : "不合格"} (exit ${t.exitCode ?? "不明"}, ${t.source})`,
                  )
                  .join(" / ")}
              </p>
            ))}
            {r.reviews.map((review, i) => (
              <div key={i}>
                <p>
                  全差分レビュー {i + 1}：
                  {review.findings.length
                    ? `${review.findings.length}件の指摘`
                    : "指摘なし（モデルレビュー）"}
                </p>
                {review.findings.map((f, n) => (
                  <p key={n}>
                    {f.severity} {f.file}:{f.line} {f.message} / 根拠：
                    {f.evidence}
                  </p>
                ))}
              </div>
            ))}
            <details>
              <summary>使用量・native状態・保存証跡</summary>
              <ModelSelectionEvidence record={r} />
              <OfficialSkillEvidence record={r} />
              {r.calls.map((call) =>
                "diagnostics" in call && call.diagnostics ? (
                  <OfficialModelEvidence
                    key={call.requestId}
                    data={call.diagnostics}
                  />
                ) : null,
              )}
              <pre>
                {JSON.stringify(
                  {
                    startedAt: r.startedAt,
                    finishedAt: r.finishedAt,
                    pendingEffect: r.pendingEffect,
                    calls: r.calls,
                    commits: r.commits,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            {r.error && (
              <p role="status">停止理由：{officialFailureMessage(r)}</p>
            )}
          </article>
        ))}
    </details>
  );
}
