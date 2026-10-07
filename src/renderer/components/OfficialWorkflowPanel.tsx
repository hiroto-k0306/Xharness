import { useEffect, useRef, useState } from "react";
import type {
  OfficialWorkflowCommand,
  OfficialWorkflowView,
} from "../../shared/official-workflow.js";
import styles from "./OfficialWorkflowPanel.module.css";
import { OfficialModelEvidence } from "./OfficialModelEvidence.js";
import { OfficialPlanAssignments } from "./OfficialPlanAssignments.js";
export function OfficialWorkflowPanel({
  mainModel,
  mainEffort,
  mainProvider,
}: {
  /** Company of the main model; questions use only this connection. */
  mainProvider?: "claude" | "codex";
  /** The main model selected now; sent once and fixed for the new task. */
  mainModel?: string;
  mainEffort?: "low" | "medium" | "high" | "xhigh" | "max";
} = {}) {
  const [open, setOpen] = useState(false),
    [view, setView] = useState<OfficialWorkflowView>(),
    [error, setError] = useState(""),
    [provider, setProvider] = useState<"claude" | "codex">("claude"),
    [mode, setMode] = useState<"single" | "dag">("single"),
    [pending, setPending] = useState(false);
  const [codexPath, setCodexPath] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [question, setQuestion] = useState("");
  const sending = useRef(false);
  // Simulated mode has no real company; keep its existing provider selection.
  const questionProvider =
    mainProvider ?? (view?.simulated ? provider : undefined);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const poll = () =>
      void window.harness
        .officialWorkflow?.({ action: "list" })
        .then((v) => {
          if (live) setView(v);
        })
        .catch(() => {
          if (live) setError("保存状態を取得できません");
        });
    poll();
    const timer = setInterval(poll, 500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [open]);
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
    <>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
        公式workflow
      </button>
      {open && (
        <section className={styles.panel} aria-label="公式単一タスクworkflow">
          <header>
            <h2>公式単一タスクworkflow</h2>
            <button
              onClick={() => setOpen(false)}
              aria-label="workflowパネルを閉じる"
            >
              閉じる
            </button>
          </header>
          <p>
            固定合成課題で、計画 → 実装 → 実テスト →
            別provider全差分レビューを確認します。元のプロジェクトは変更しません。
          </p>
          <p>
            {view?.simulated
              ? "FAKE：モデルは模擬、受入テストは実プロセスです。"
              : "公式SDK / App Serverの既存サブスクを使用します。計画生成も枠を使用します。追加課金へ切り替えません。"}
          </p>
          <label>
            公式Codex実行パス
            <input
              aria-label="公式Codex実行パス"
              value={codexPath}
              placeholder={view?.connection?.codexPath || "C:\\...\\codex.exe"}
              onChange={(e) => setCodexPath(e.target.value)}
            />
          </label>
          <button
            disabled={pending || !!view?.activeId || !codexPath.trim()}
            onClick={() =>
              void send({ action: "configure", codexPath: codexPath.trim() })
            }
          >
            公式接続設定を保存
          </button>
          <p role="status">{view?.connection?.message}</p>
          <p aria-label="計画モデル">
            計画モデル：{mainModel ?? "未選択"}
            {mainEffort ? `（${mainEffort}）` : ""}
            。作成時に確定し、実行中に選択を変えても次のタスクから反映します。利用できない場合は理由を表示し、別のモデルへ切り替えません。
          </p>
          <label>
            合成課題workspaceの保存先
            <input
              aria-label="合成課題workspaceの保存先"
              value={workspaceRoot}
              placeholder={
                view?.connection?.workspaceRoot ||
                "未設定（workflow保存領域の中）"
              }
              onChange={(e) => setWorkspaceRoot(e.target.value)}
            />
          </label>
          <button
            disabled={pending || !!view?.activeId}
            onClick={() =>
              void send({
                action: "workspace_root",
                path: workspaceRoot.trim(),
              })
            }
          >
            workspace保存先を保存
          </button>
          <p>
            既存のフォルダの絶対パスを指定します。存在・書き込み可否を確認し、使えない場合は理由を表示して停止します（別の場所へ自動で切り替えません）。空で保存すると既定に戻ります。既存の記録は移動しません。
          </p>
          {view?.operationApproval && (
            <section
              className={styles.operationApproval}
              role="alertdialog"
              aria-label="今回の操作の承認"
              key={view.operationApproval.approvalId}
            >
              <h3>操作の許可が必要です</h3>
              <p>
                今回の読み取り操作だけを許可します。60秒以内に回答がなければ拒否します。
              </p>
              <p>操作：{view.operationApproval.command}</p>
              <p>対象：{view.operationApproval.targets.join(", ")}</p>
              <p>作業場所：{view.operationApproval.cwd}</p>
              <p>要求理由：{view.operationApproval.reason}</p>
              <p>
                セッション：{view.operationApproval.sessionId} / request：
                {view.operationApproval.requestId}
              </p>
              <p>
                期限：
                {new Date(
                  view.operationApproval.expiresAt,
                ).toLocaleTimeString()}
              </p>
              {[true, false].map((allow) => (
                <button
                  key={String(allow)}
                  disabled={pending}
                  onClick={() =>
                    void send({
                      action: "tool_decision",
                      id: view.operationApproval!.workflowId,
                      approvalId: view.operationApproval!.approvalId,
                      digest: view.operationApproval!.digest,
                      allow,
                    })
                  }
                >
                  {allow ? "今回の操作だけ許可" : "拒否"}
                </button>
              ))}
            </section>
          )}
          <p>
            計画はOpus、実装候補はHaiku / Codex
            Luna。最大7回のphase呼出・各120秒・修正2回で終了します。SDK内部のモデル往復数は別です。
          </p>
          <label>
            実行方式{" "}
            <select
              aria-label="workflow実行方式"
              value={mode}
              onChange={(e) => setMode(e.target.value as "single" | "dag")}
            >
              <option value="single">単一タスク</option>
              <option value="dag" disabled={!view?.simulated}>
                合成DAG（模擬・最大2並列）
              </option>
            </select>
          </label>
          {mode === "dag" && (
            <p>
              DAGは固定合成課題の模擬実行です。実provider並行実行は未検証。native会話のresumeは行わず、安全な保存段階から新しいphaseを開始します。
            </p>
          )}
          <label>
            実装候補{" "}
            <select
              aria-label="公式workflow実装候補"
              value={provider}
              disabled={mode === "dag"}
              onChange={(e) =>
                setProvider(e.target.value as "claude" | "codex")
              }
            >
              <option value="claude">Claude → Codexレビュー</option>
              <option value="codex">Codex → Claudeレビュー</option>
            </select>
          </label>
          <button
            disabled={
              !view?.available || !!view.activeId || pending || !mainModel
            }
            onClick={() =>
              void send({
                action: "create",
                provider,
                mode,
                ...(mainModel
                  ? {
                      planner: { model: mainModel, effort: mainEffort ?? null },
                    }
                  : {}),
              })
            }
          >
            合成課題の計画を作成
          </button>
          {view?.verification === "fix-cycle-v1" && (
            <section aria-label="修正経路の検証モード">
              <p>
                検証モード：障害注入あり。専用の検証課題でだけ、実装（X1）の品質テストが合格した後に、既知の不良コミット（X2）を注入して修正経路を確認します。
              </p>
              <button
                disabled={
                  !view.available ||
                  !!view.activeId ||
                  pending ||
                  !mainModel ||
                  mode === "dag"
                }
                onClick={() =>
                  void send({
                    action: "create",
                    provider,
                    mode: "single",
                    task: "typed-add-v1",
                    ...(mainModel
                      ? {
                          planner: {
                            model: mainModel,
                            effort: mainEffort ?? null,
                          },
                        }
                      : {}),
                  })
                }
              >
                修正経路の検証課題を作成
              </button>
            </section>
          )}
          <label>
            質問・追加質問（計画を作らない）
            <textarea
              aria-label="公式接続への質問"
              value={question}
              maxLength={4000}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </label>
          <button
            disabled={
              !questionProvider ||
              !view?.storageReady ||
              (questionProvider === "codex" &&
                !view.simulated &&
                view.connection?.status !== "configured") ||
              !!view.activeId ||
              pending ||
              !question.trim()
            }
            onClick={() =>
              questionProvider &&
              void send({
                action: "chat",
                provider: questionProvider,
                text: question.trim(),
              })
            }
          >
            質問だけ送信
          </button>
          <p aria-label="質問先">
            質問先：
            {!questionProvider
              ? "未選択"
              : `${questionProvider === "claude" ? "Claude" : "Codex"} ${questionModelLabel(
                  view,
                  questionProvider,
                )}`}
            {mainProvider
              ? "（メインモデルの会社）"
              : "（模擬：実装候補の選択）"}
            。この会社の接続だけを確認し、1回・60秒まで。直近5件を文脈に含めます。計画・実装は起動しません。
          </p>
          {!view?.available && (
            <p>
              公式workflowは未設定です。上の公式Codex実行パスを設定してください。未設定では送信しません。
            </p>
          )}
          {(error || view?.error) && <p role="alert">{error || view?.error}</p>}
          {view?.records.map(({ record: r, resumeBlocked, reportHref }) => (
            <article key={r.id}>
              <h3>
                {r.status} / 修正 {r.correctionRounds}回
              </h3>
              <a href={reportHref}>HTMLレポートを開く</a>
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
                      {n.id}: {n.state} / base{" "}
                      {n.base?.slice(0, 12) ?? "未確定"} / 取込{" "}
                      {n.integratedHead?.slice(0, 12) ?? "未取込"}
                    </p>
                  ))}
                </div>
              )}
              <small>
                task {r.id} / 次の段階 {r.next} / 再開 {r.resumed ?? 0}回
              </small>
              <p>
                base {r.base.slice(0, 12)} → head {r.head.slice(0, 12)}
              </p>
              {r.plan && (
                <>
                  <h4>確認する計画</h4>
                  <p>{r.plan.summary}</p>
                  {r.plan.tasks.map((t) => (
                    <div key={t.id}>
                      <strong>{t.title}</strong>
                      <p>{t.instructions}</p>
                      <p>
                        対象 {t.files.join(", ")} / テスト{" "}
                        {t.acceptance.join(", ")} / 依存{" "}
                        {t.dependsOn.join(", ") || "なし"}
                      </p>
                      <OfficialPlanAssignments record={r} task={t} />
                    </div>
                  ))}
                </>
              )}
              {view.approval?.id === r.id && (
                <>
                  {r.injection && (
                    <p>
                      この課題は検証用です。実装（X1）の品質テストが合格した後に、既知の不良コミット（X2）を注入し、テスト・レビュー・修正（X3）を確認します。
                    </p>
                  )}
                  <p>承認digest：{view.approval.digest}</p>
                  <button
                    disabled={pending}
                    onClick={() =>
                      void send({
                        action: "approve",
                        id: r.id,
                        digest: view.approval!.digest,
                      })
                    }
                  >
                    この計画を承認
                  </button>
                </>
              )}
              {view.activeId === r.id ? (
                <button
                  onClick={() => void send({ action: "cancel", id: r.id })}
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
              <h4>実テストとレビューの証跡</h4>
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
              {r.error && <p role="status">停止理由：{r.error}</p>}
            </article>
          ))}
          {view?.activeId &&
            !view.records.some((v) => v.record.id === view.activeId) && (
              <p>
                公式接続と利用可能な枠を確認しています。
                <button
                  onClick={() =>
                    void send({ action: "cancel", id: view.activeId! })
                  }
                >
                  接続確認を中断
                </button>
              </p>
            )}
        </section>
      )}
    </>
  );
}
/** Shows the service's catalog resolution, so the label is the model actually used. */
function questionModelLabel(
  view: OfficialWorkflowView | undefined,
  provider: "claude" | "codex",
) {
  if (view?.simulated) return "模擬モデル";
  const resolved = view?.questionModels?.[provider];
  if (!resolved) return "未確認";
  return "id" in resolved
    ? `${resolved.id}${resolved.effort ? `（${resolved.effort}）` : ""}`
    : `利用不可（${resolved.error}）`;
}
