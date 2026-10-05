import { compareEvaluations, type ComparisonEntry } from "./evaluation.js";

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
/** No aggregate leaderboard across different cases or difficulty. */
export function renderComparison(entries: ComparisonEntry[]) {
  const groups = compareEvaluations(entries);
  const sections = groups
    .map(
      (group) =>
        `<section><h2>${escape(group.conditions.join(" / "))}</h2><table><thead><tr><th>構成 / 観測モデル・effort</th><th>品質基準</th><th>終了</th><th>In / カバー率</th><th>Out / カバー率</th><th>所要時間</th><th>資源比較</th></tr></thead><tbody>${group.runs
          .map((run) => {
            const models = [
              ...new Set(
                run.task.calls.map(
                  (c) =>
                    `${c.provider}:${c.model ?? "不明"}/${c.effort ?? "不明"}`,
                ),
              ),
            ];
            return `<tr><td>${escape(run.configuration)}<br>${escape(models.join(", "))}</td><td>${run.qualitySatisfied ? "充足" : "未充足・未評価"}<br>${escape(run.assessment ? `${run.assessment.source}: ${run.assessment.evidence}` : "評価根拠なし")}</td><td>${run.task.outcome}<br>レビュー ${run.task.reviewAttempts} / 修正 ${run.task.correctionRounds}</td><td>${run.task.metrics.input.known ?? "不明"} / ${run.task.metrics.input.measuredCalls}/${run.task.calls.length}</td><td>${run.task.metrics.output.known ?? "不明"} / ${run.task.metrics.output.measuredCalls}/${run.task.calls.length}</td><td>${run.task.elapsedMs ?? "不明"} ms</td><td>${run.qualitySatisfied && run.resourceComparable ? "同等品質の比較対象" : "参考値（品質・欠測・模擬を確認）"}</td></tr>`;
          })
          .join("")}</tbody></table></section>`,
    )
    .join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>XHarness 評価比較</title><style>body{font:15px/1.6 system-ui;background:#10151f;color:#e5eaf2;margin:24px}section{overflow:auto}table{border-collapse:collapse;width:100%;margin:20px 0}td,th{border:1px solid #526079;text-align:left;padding:12px}th{background:#192231}h2{font-size:18px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>XHarness 品質優先の比較</h1><p>同じ課題・種別・難度・評価基準・環境ごとに表示します。まず明示的な評価の合格を確認し、その条件を満たした記録の使用量と所要時間を比較してください。横断ランキングや自動ルーティングはありません。モデル自己申告とレビューは客観テスト合格の代わりになりません。</p><p>Inはcacheを含む総入力、Outはreasoningを含む総出力です。取得済み値のカバー率を示し、未取得分をゼロに補いません。模擬記録は集計機能の検証用です。</p>${sections}<details><summary>全記録と根拠</summary><pre>${escape(JSON.stringify(groups, null, 2))}</pre></details></body></html>`;
}
