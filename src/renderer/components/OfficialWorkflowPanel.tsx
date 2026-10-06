import { useEffect, useState } from "react";
import type {
  OfficialWorkflowCommand,
  OfficialWorkflowView,
} from "../../shared/official-workflow.js";
import styles from "./OfficialWorkflowPanel.module.css";
export function OfficialWorkflowPanel() {
  const [open, setOpen] = useState(false),
    [view, setView] = useState<OfficialWorkflowView>(),
    [error, setError] = useState(""),
    [provider, setProvider] = useState<"claude" | "codex">("claude"),
    [mode, setMode] = useState<"single" | "dag">("single"),
    [pending, setPending] = useState(false);
  const [codexPath, setCodexPath] = useState("");
  const [question, setQuestion] = useState("");
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
    setPending(true);
    setError("");
    try {
      const result = await window.harness.officialWorkflow?.(command);
      if (result) setView(result);
    } catch {
      setError("操作を完了できませんでした。自動再送はしていません。");
    } finally {
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
            disabled={!view?.available || !!view.activeId || pending}
            onClick={() => void send({ action: "create", provider, mode })}
          >
            合成課題の計画を作成
          </button>
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
              !view?.available || !!view.activeId || pending || !question.trim()
            }
            onClick={() =>
              void send({ action: "chat", provider, text: question.trim() })
            }
          >
            質問だけ送信
          </button>
          <p>
            選択したproviderに1回・60秒まで。直近5件を文脈に含めます。計画・実装は起動しません。
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
                      <p>
                        {t.assignee.provider} / {t.assignee.model} /{" "}
                        {t.assignee.effort ?? "server default"}
                      </p>
                      <p>選択理由：{t.assignee.reason}</p>
                    </div>
                  ))}
                </>
              )}
              {view.approval?.id === r.id && (
                <>
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
