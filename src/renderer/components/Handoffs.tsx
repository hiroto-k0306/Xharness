import { useEffect, useRef, useState } from "react";
import { type SessionSummary } from "../../shared/ipc.js";
import {
  handoffReference,
  type HandoffAction,
  type HandoffView,
} from "../../shared/handoffs.js";
import styles from "./ProjectMemory.module.css";

export function HandoffsPanel({
  session,
  sessions,
}: {
  session: SessionSummary;
  sessions: SessionSummary[];
}) {
  const [open, setOpen] = useState(false),
    [view, setView] = useState<HandoffView>(),
    [destination, setDestination] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0),
    active = useRef(false);
  const cancel = () => {
    generation.current++;
    setView(undefined);
    setConfirmed(false);
    void window.harness.command({
      type: "handoffs",
      sessionId: session.id,
      request: { action: "cancel", previewId: "all" },
    });
  };
  useEffect(
    () => () => {
      generation.current++;
      void window.harness.command({
        type: "handoffs",
        sessionId: session.id,
        request: { action: "cancel", previewId: "all" },
      });
    },
    [session.id],
  );
  const run = async (request: HandoffAction) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    setConfirmed(false);
    const seq = ++generation.current;
    try {
      const r = await window.harness.command({
        type: "handoffs",
        sessionId: session.id,
        request,
      });
      if (seq !== generation.current) return;
      if (!r.ok) {
        setError(r.error);
        setView(undefined);
      } else setView(r.handoffs);
    } catch {
      if (seq === generation.current) {
        setError("配送状態を確認できません。受信一覧を再取得してください。");
        setView(undefined);
      }
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return (
    <div className={styles.area}>
      <button
        onClick={() => {
          setOpen(true);
          void run({ action: "list" });
        }}
      >
        結果の受け渡し
      </button>
      {open && (
        <section
          role="dialog"
          aria-label="結果の受け渡し"
          className={styles.panel}
        >
          <header>
            <strong>結果の受け渡し</strong>
            <button
              onClick={() => {
                cancel();
                setOpen(false);
              }}
            >
              閉じる
            </button>
          </header>
          <p>
            確定した最新タスクの最終回答1件を、同じprojectの別会話へ参照として保存します。受信はモデル実行やテスト合格を意味しません。権限・system・隠れた推論は移しません。
          </p>
          <label>
            宛先会話
            <select
              aria-label="宛先会話"
              value={destination}
              disabled={busy}
              onChange={(e) => {
                cancel();
                setDestination(e.target.value);
              }}
            >
              <option value="">選択してください</option>
              {sessions
                .filter(
                  (s) =>
                    s.id !== session.id &&
                    s.workspaceId === session.workspaceId,
                )
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title || s.id} · {s.id}
                  </option>
                ))}
            </select>
          </label>
          <button
            disabled={busy || !destination}
            onClick={() =>
              void run({ action: "preview", destinationId: destination })
            }
          >
            送信プレビュー
          </button>
          <button disabled={busy} onClick={() => void run({ action: "list" })}>
            送信・受信一覧を再取得
          </button>
          {error && <p role="alert">{error}</p>}
          {view?.preview && (
            <article>
              <strong>未送信の確認票（60秒）</strong>
              <p>
                出典会話: {view.preview.sourceId} / task: {view.preview.taskId}
                <br />
                完了日時: {view.preview.completedAt}
                <br />
                宛先: {view.preview.destinationId}
                <br />
                本文hash: {view.preview.bodyHash}
              </p>
              <p>{view.preview.body}</p>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                本文と宛先を確認して参照として送信する
              </label>
              <button
                disabled={busy || !confirmed}
                onClick={() =>
                  void run({
                    action: "confirm",
                    previewId: view.preview!.id,
                    confirmed: true,
                  })
                }
              >
                明示送信
              </button>
              <button onClick={cancel}>取消</button>
            </article>
          )}
          {view?.records.map((r) => (
            <article key={r.id}>
              <strong>
                {r.destinationId === session.id ? "受信済み" : "送信・受信確定"}{" "}
                · モデル未実行
              </strong>
              <p>
                配送: {r.id}
                <br />
                出典: {r.sourceId} / task: {r.taskId}
                <br />
                完了: {r.completedAt}
                <br />
                受信: {r.receivedAt}
                <br />
                宛先: {r.destinationId}
                <br />
                出典会話:{" "}
                {r.sourceAvailable
                  ? "現在参照可能（本文は送信時のsnapshot）"
                  : "削除・移動・参照不可（送信時のsnapshot）"}
              </p>
              <details>
                <summary>未信頼の参照本文と出典</summary>
                <p>{handoffReference(r)}</p>
              </details>
              {r.destinationId === session.id && (
                <button
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(handoffReference(r))
                      .catch(() =>
                        setError(
                          "コピーできません。本文を手動で選択してください。",
                        ),
                      )
                  }
                >
                  参照と出典をコピー
                </button>
              )}
            </article>
          ))}
          <p>
            使用する場合は、受信側の通常の入力欄へ参照と新しい依頼を貼り付け、送信してください。受信側の通常の許可確認が必要です。任意の双方向会話・自動送信・自動再実行には対応していません。
          </p>
        </section>
      )}
    </div>
  );
}
