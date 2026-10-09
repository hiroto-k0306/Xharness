import { useEffect, useState } from "react";
import { type ImprovementAction } from "../../shared/improvements.js";
import { type ModelCandidateView } from "../../shared/model-candidates.js";
import styles from "./Improvements.module.css";
export function ModelCandidates({
  selection,
  view,
  busy,
  command,
}: {
  selection: {
    id: string;
    revision: number;
    versionId: string;
    caseId: string;
  };
  view?: ModelCandidateView;
  busy: boolean;
  command(a: ImprovementAction): Promise<void>;
}) {
  const [selected, setSelected] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [reason, setReason] = useState("");
  useEffect(() => {
    if (busy) setConfirmed(false);
  }, [busy]);
  const chosen = view?.candidates.find((c) => c.id === selected);
  return (
    <section aria-label="根拠付きモデル候補" className={styles.candidates}>
      <h3>根拠付きモデル候補</h3>
      <p>
        この版・課題の同一固定入力だけを比較します。人の明示評価は客観テスト合格と別の根拠です。模擬は本番の優越・最適性を示しません。In/Outはサブスク枠・費用ではありません。異なるprovider・cache内訳を同一尺度の点数にしません。
      </p>
      <button
        disabled={busy}
        onClick={() =>
          void command({ ...selection, action: "model_candidates" })
        }
      >
        モデル候補を確認（通信なし）
      </button>
      {view && (
        <>
          <p>{view.conditions}</p>
          <p>
            取得 {new Date(view.observedAt).toLocaleString()} / 確認期限{" "}
            {new Date(view.expiresAt).toLocaleString()}
            。選択直前に再照合します。
          </p>
          {view.allExhausted && (
            <p role="status">
              全候補を共有枠枯渇で見送り。既存の「枠待ち」表示で条件・再開時刻・明示許可を確認してください。安全な待機記録がない場合は手動で待ち、新しい依頼を確認してください。別モデルを自動試行しません。
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>モデル / effort</th>
                <th>品質優先・比較理由</th>
                <th>利用枠・scope・鮮度</th>
                <th>課題別の観測と根拠</th>
              </tr>
            </thead>
            <tbody>
              {view.candidates.map((c) => (
                <tr key={c.id}>
                  <td>{c.id}</td>
                  <td>
                    {c.priority
                      ? "優先検討（実測根拠あり）"
                      : c.selectable
                        ? "優先根拠不足"
                        : "共有枠枯渇・見送り"}
                    <details>
                      <summary>比較理由・限界</summary>
                      {c.reasons.map((r, i) => (
                        <p key={i}>{r}</p>
                      ))}
                    </details>
                  </td>
                  <td>
                    {c.quota.state} / {c.quota.scope}
                    <br />
                    {c.quota.observedAt
                      ? new Date(c.quota.observedAt).toLocaleString()
                      : "未観測"}
                    <details>
                      <summary>枠ごとの観測・鮮度</summary>
                      {c.quota.reasons.map((r, i) => (
                        <p key={i}>{r}</p>
                      ))}
                    </details>
                  </td>
                  <td>
                    {c.samples.length
                      ? c.samples.map((s) => (
                          <p key={`${s.sessionId}/${s.taskId}`}>
                            {s.sessionId}/{s.taskId}
                            <br />
                            観測完了{" "}
                            {s.measuredAt === null
                              ? "不明"
                              : new Date(s.measuredAt).toLocaleString()}
                            <br />
                            明示評価: {s.evidence}
                            <br />
                            {s.reason}
                            <br />
                            In {s.input ?? "不明"} / Out {s.output ?? "不明"} /
                            時間 {s.elapsedMs ?? "不明"} ms
                            <br />
                            {s.coverage}
                            <br />
                            cache-read/write: {s.cache}
                          </p>
                        ))
                      : "未測定"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!!view.omitted.length && (
            <details>
              <summary>比較から除外した根拠</summary>
              {view.omitted.map((r) => (
                <p key={r}>{r}</p>
              ))}
            </details>
          )}
          <label>
            明示選択するモデル
            <select
              aria-label="明示選択するモデル"
              disabled={busy}
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setConfirmed(false);
              }}
            >
              <option value="">選択してください</option>
              {view.candidates.map((c) => (
                <option key={c.id} value={c.id} disabled={!c.selectable}>
                  {c.id}
                  {!c.selectable ? "（共有枠枯渇・見送り）" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            モデル選択理由
            <textarea
              aria-label="モデル選択理由"
              disabled={busy}
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              disabled={busy}
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            モデルと根拠不足を確認して明示選択
          </label>
          <button
            disabled={
              busy || !chosen?.selectable || !confirmed || !reason.trim()
            }
            onClick={() =>
              void command({
                ...selection,
                action: "select_model_candidate",
                candidateId: selected,
                snapshot: view.snapshot,
                confirmed: true,
                reason,
              })
            }
          >
            候補をこのセッションに適用（通信なし）
          </button>
          <p>
            このセッションのモデル・effortだけを保存します。既定値は変更せず、自動再送しません。次の依頼は通常の権限・fallbackに従います。
          </p>
        </>
      )}
    </section>
  );
}
