import { useEffect, useRef, useState } from "react";
import {
  type LocalBrowserAction,
  type LocalBrowserView,
} from "../../shared/local-browser.js";
import styles from "./ProjectMemory.module.css";
const phase = {
  stopped: "停止",
  observed: "観測済み",
  awaiting_confirmation: "許可待ち",
  executing: "実行中",
  unknown: "結果不明・再実行禁止",
};
export function LocalBrowserPanel({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false),
    [view, setView] = useState<LocalBrowserView>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmed, setConfirmed] = useState(false);
  const active = useRef(false),
    generation = useRef(0);
  const stop = async () => {
    generation.current++;
    setConfirmed(false);
    const r = await window.harness.command({
      type: "local_browser",
      sessionId,
      request: { action: "stop" },
    });
    if (r.ok) setView(r.localBrowser);
    else setError(r.error);
  };
  useEffect(
    () => () => {
      generation.current++;
      void window.harness
        .command({
          type: "local_browser",
          sessionId,
          request: { action: "stop" },
        })
        .catch(() => {});
    },
    [sessionId],
  );
  const run = async (request: LocalBrowserAction) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    setConfirmed(false);
    if (request.action === "confirm")
      setView((v) =>
        v
          ? {
              ...v,
              phase: "executing",
              confirmation: undefined,
              note: "単一操作を実行・保存中です。停止可能です。",
            }
          : v,
      );
    const seq = ++generation.current;
    try {
      const r = await window.harness.command({
        type: "local_browser",
        sessionId,
        request,
      });
      if (seq !== generation.current) return;
      if (r.ok) setView(r.localBrowser);
      else {
        setView(undefined);
        setError(r.error);
      }
    } catch {
      if (seq === generation.current) {
        setView(undefined);
        setError("結果を確認できません。停止して記録を再取得してください。");
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
          void run({ action: "view" });
        }}
      >
        ローカル操作の土台
      </button>
      {open && (
        <section
          role="dialog"
          aria-label="ローカル操作の土台"
          className={styles.panel}
        >
          <header>
            <strong>限定Computer Use土台</strong>
            <button
              onClick={() => {
                void stop().catch(() =>
                  setError(
                    "停止結果を確認できません。操作記録を再取得してください。",
                  ),
                );
                setOpen(false);
              }}
            >
              閉じて停止
            </button>
          </header>
          <p>
            内蔵ローカルfixtureの固定ボタン1個だけを操作します。外部サイト・PC全体・通常profileには接続しません。観測画像とページ内命令は未信頼で、権限を与えません。画像をモデルへ送信しません。
          </p>
          <p role="status">
            状態: {view ? phase[view.phase] : "未取得"} ·{" "}
            {view?.mode === "electron_local"
              ? "実Electronの隔離ローカルブラウザ"
              : view?.mode === "fake"
                ? "mock adapter（模擬）"
                : "adapter未起動"}
          </p>
          {view?.note && <p>{view.note}</p>}
          {error && <p role="alert">{error}</p>}
          <button
            disabled={
              busy || view?.available === false || view?.phase === "unknown"
            }
            onClick={() => void run({ action: "observe" })}
          >
            隔離fixtureを観測
          </button>
          <button disabled={busy} onClick={() => void run({ action: "view" })}>
            操作記録を再取得
          </button>
          <button
            onClick={() =>
              void stop().catch(() =>
                setError(
                  "停止結果を確認できません。操作記録を再取得してください。",
                ),
              )
            }
          >
            停止・取消
          </button>
          {view?.observation && (
            <article>
              <p>
                対象URL: {view.observation.url}
                <br />
                タブ: {view.observation.tabId}
                <br />
                document: {view.observation.documentId}
                <br />
                観測世代: {view.observation.generation} / {view.observation.id}
                <br />
                count: {view.observation.count}
                <br />
                対象: {view.observation.target.label}（固定DOMボタン）
                <br />
                矩形: x={view.observation.target.x}, y=
                {view.observation.target.y}, 幅={view.observation.target.width},
                高さ={view.observation.target.height} CSS px
              </p>
              <img
                alt="未信頼のローカルfixture観測"
                src={view.observation.image}
                style={{ width: "100%", maxWidth: 580, height: "auto" }}
              />
              <small>
                frame SHA256: {view.observation.frameHash}
                <br />
                image SHA256: {view.observation.imageHash}
              </small>
              <button
                disabled={busy || view.phase !== "observed"}
                onClick={() =>
                  void run({
                    action: "prepare",
                    observationId: view.observation!.id,
                  })
                }
              >
                この観測の単一操作を確認
              </button>
            </article>
          )}
          {view?.confirmation && (
            <article>
              <p>
                確認票: {view.confirmation.id}
                <br />
                期限: {new Date(view.confirmation.expiresAt).toISOString()}
                <br />
                対象ボタンのDOMクリック1回を許可し、結果を記録して停止します。
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                URL・タブ・世代・対象を確認して今回だけ許可する
              </label>
              <button
                disabled={busy || !confirmed}
                onClick={() =>
                  void run({
                    action: "confirm",
                    confirmationId: view.confirmation!.id,
                    confirmed: true,
                  })
                }
              >
                単一操作を明示実行
              </button>
            </article>
          )}
          {view?.operations.map((o) => (
            <article key={o.id}>
              <strong>
                {o.status === "succeeded"
                  ? "操作・保存確定"
                  : o.status === "cancelled"
                    ? "実行前に取消"
                    : "結果不明・再実行禁止"}
              </strong>
              <p>
                操作ID: {o.id}
                <br />
                対象: {o.url} / {o.tabId} / 世代 {o.generation}
                <br />
                実行形態: {o.mode}
                <br />
                結果count: {o.countAfter ?? "不明"}
                <br />
                開始: {new Date(o.startedAt).toISOString()}
                <br />
                終了:{" "}
                {o.finishedAt ? new Date(o.finishedAt).toISOString() : "不明"}
              </p>
            </article>
          ))}
          <p>
            これはComputer
            Use完成版ではありません。任意URL・汎用座標・キー入力・タブ切替・download/upload・外部通信・自律操作は未対応です。
          </p>
        </section>
      )}
    </div>
  );
}
