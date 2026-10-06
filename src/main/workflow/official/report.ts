import type { WorkflowRecord } from "./runtime.js";
import { workflowUsage } from "./runtime.js";
import { normalizeTokens } from "../../providers/token-usage.js";
const escape = (value: unknown) =>
  String(value ?? "不明")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
/** Standalone reviewable report; no script, provider response body, credential or thinking content. */
export function officialWorkflowReport(record: WorkflowRecord) {
  const usage = workflowUsage(record),
    cells = (values: unknown[]) =>
      values.map((v) => `<td>${escape(v)}</td>`).join("");
  const calls = record.calls
    .map((c) => ({
      ...c,
      phase: c.nodeId ? `${c.nodeId}: ${c.phase}` : c.phase,
    }))
    .map((c) => {
      const measured =
        "usage" in c && c.usage ? normalizeTokens(c.usage.measurement) : null;
      return `<tr>${cells([c.phase, c.provider, c.requestedModel, c.effort ?? "server default", "observedModels" in c ? c.observedModels.join(", ") : "不明", c.status, measured?.input, measured?.output, measured?.cacheRead, measured?.cacheWrite, measured?.reasoning, "usage" in c ? c.usage?.scope : "不明", "elapsedMs" in c ? c.elapsedMs : "不明"])}</tr>`;
    })
    .join("");
  const plan =
    record.plan?.tasks
      .map(
        (t) =>
          `<tr>${cells([t.title, t.files.join(", "), t.dependsOn.join(", ") || "なし", `${t.assignee.provider} / ${t.assignee.model}`, t.assignee.reason, t.acceptance.join(", ")])}</tr>`,
      )
      .join("") ?? "";
  const tests = record.checks
    .flatMap((round) =>
      round.tests.map(
        (t) =>
          `<tr>${cells([round.head.slice(0, 12), t.id, t.exitCode, t.passed ? "合格" : "不合格", t.elapsedMs, t.source])}</tr>`,
      ),
    )
    .join("");
  const dagSummary = record.dag
    ? `<h3>DAG / 最大2並列 / native会話resume未対応</h3><p>固定合成課題の模擬実行。実provider並行実行は未検証。</p><table><tr><th>node</th><th>状態</th><th>base</th><th>取込HEAD</th></tr>${record.dag.nodes.map((n) => `<tr>${cells([n.id, n.state, n.base, n.integratedHead])}</tr>`).join("")}</table>`
    : "";
  const reviews =
    dagSummary +
    record.reviews
      .map(
        (r) =>
          `<article><p>${escape(r.base)} → ${escape(r.head)}</p>${r.findings.length ? r.findings.map((f) => `<p><strong>${escape(f.severity)}</strong> ${escape(f.file)}:${f.line} — ${escape(f.message)}<br>根拠: ${escape(f.evidence)}</p>`).join("") : "<p>指摘なし（モデルレビュー。客観テストとは別）</p>"}</article>`,
      )
      .join("");
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>XHarness official workflow</title><style>body{max-width:1400px;margin:32px auto;padding:0 20px;font:15px system-ui;background:#111722;color:#e6e9ee}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{padding:10px;text-align:left;border:1px solid #384255;overflow-wrap:anywhere}h1,h2{color:#9cbbfc}pre{white-space:pre-wrap}article{border-left:3px solid #657baf;padding-left:16px}</style><h1>公式workflow — ${escape(record.status)}</h1><p>${escape(record.goal)}</p>${record.answer ? `<h2>回答</h2><p>${escape(record.answer)}</p>` : ""}<p>${record.simulated ? "模擬実行。実モデルの品質・速度比較には使いません。" : "実行記録。モデル自己申告をテスト合格に読み替えません。"}</p><p>タスク ${escape(record.id)} / 修正 ${record.correctionRounds}回 / ${escape(record.startedAt)} → ${escape(record.finishedAt)}</p><p>base ${escape(record.base)}<br>head ${escape(record.head)}<br>計画承認 ${escape(record.approvedDigest)}</p><h2>確認する計画</h2><table><tr><th>課題</th><th>ファイル</th><th>依存</th><th>実装担当</th><th>理由</th><th>受入テスト</th></tr>${plan}</table><h2>総使用量とカバー率</h2><p>入力の既知合計 ${escape(usage.input.known)} (${usage.input.measuredCalls}/${usage.dispatchedCalls} calls)、出力 ${escape(usage.output.known)} (${usage.output.measuredCalls}/${usage.dispatchedCalls} calls)、完全usage ${usage.completeUsageCalls}/${usage.dispatchedCalls} calls。cache/reasoningはproviderの包含関係を保ち二重加算しません。サブスク枠消費・料金への換算はしません。runningの未確認試行は欠測として別に扱います。</p><table><tr><th>段階</th><th>provider</th><th>指定model</th><th>effort</th><th>観測model</th><th>状態</th><th>In</th><th>Out</th><th>cache read</th><th>cache write</th><th>reasoning</th><th>scope</th><th>ms</th></tr>${calls}</table><h2>プロセスで確認した受入・統合テスト</h2><table><tr><th>head</th><th>テスト</th><th>退出値</th><th>結果</th><th>ms</th><th>根拠source</th></tr>${tests}</table><h2>他社による全差分・統合レビュー</h2>${reviews}<h2>コミットと実行境界</h2><pre>${escape(record.commits.join("\n"))}</pre><p>native session/turn ID、tool input/outputのdigest、承認・実行状態、プロセス出力は同じタスクのJSONに保存します。再開でrunning試行や不明な副作用を自動再実行しません。</p>${record.error ? `<p>停止理由 ${escape(record.error)}</p>` : ""}</html>`;
}
