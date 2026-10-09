import { useState } from "react";
import {
  type Improvement,
  type ImprovementAction,
  type ImprovementRow,
} from "../../shared/improvements.js";
export function ImprovementEvaluation({
  e,
  versionId,
  caseId,
  rows,
  busy,
  command,
}: {
  e: Improvement;
  versionId: string;
  caseId: string;
  rows: ImprovementRow[];
  busy: boolean;
  command(request: ImprovementAction): Promise<void>;
}) {
  const [evidence, setEvidence] = useState(""),
    [passed, setPassed] = useState(false);
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void command({
            action: "record",
            id: e.id,
            revision: e.revision,
            versionId,
            caseId,
            sessionId: "current",
            taskId: "current",
            passed,
            evidence,
          });
        }}
      >
        <h3>この会話の保存済み評価を登録</h3>
        <p>
          準備した依頼と完全一致する新規会話だけ登録できます。人が保存済み出力・テスト結果を確認した明示評価で、モデル自己申告をテスト合格と扱いません。
        </p>
        <textarea
          aria-label="評価根拠"
          required
          maxLength={2000}
          value={evidence}
          onChange={(x) => setEvidence(x.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={passed}
            onChange={(x) => setPassed(x.target.checked)}
          />
          品質基準を満たすと確認した
        </label>
        <button disabled={busy}>結果を登録</button>
      </form>
      <h3>課題ごとの比較（品質充足を先に確認）</h3>
      <p>
        環境欄は利用者の申告です。作業木・依存関係・評価手順を揃えてください。観測モデル・effortが異なる場合、本文だけの効果とは判断できません。未取得は不明、サブスク残量・API費用は対象外。
      </p>
      <table>
        <thead>
          <tr>
            {[
              "版／課題",
              "品質・根拠",
              "In／カバー率",
              "Out／カバー率",
              "時間ms",
              "観測条件",
            ].map((t) => (
              <th key={t}>{t}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {e.results.map((r) => {
            const row = rows.find(
              (x) =>
                x.sessionId === r.sessionId &&
                x.taskId === r.taskId &&
                x.versionId === r.versionId,
            );
            return (
              <tr key={`${r.sessionId}/${r.taskId}`}>
                <td>
                  {e.versions.find((v) => v.id === r.versionId)?.name} /{" "}
                  {r.caseId}
                  <br />
                  {r.sessionId} / {r.taskId}
                </td>
                <td>
                  {row?.quality ? "充足（明示評価）" : "未充足・未評価"}
                  <br />
                  {row?.evidence}
                </td>
                <td>
                  {row?.input ?? "不明"} / {row?.inputCoverage}
                </td>
                <td>
                  {row?.output ?? "不明"} / {row?.outputCoverage}
                </td>
                <td>{row?.elapsedMs ?? "不明"}</td>
                <td>
                  {row?.models.join(", ")}
                  <br />
                  {row?.note}
                  <br />
                  {row?.quality && row.resourceComparable
                    ? "同等品質の資源比較対象"
                    : "参考値"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
