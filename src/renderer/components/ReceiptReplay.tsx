import { useEffect, useState } from "react";
import { type ReceiptReplay } from "../../shared/replay.js";
import styles from "./Activity.module.css";

export function ReceiptReplayDialog({
  replay,
  onClose,
}: {
  replay: ReceiptReplay;
  onClose(): void;
}) {
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const last = replay.frames.length - 1;
  const move = (delta: number) => {
    setPlaying(false);
    setPosition((p) => Math.max(0, Math.min(last, p + delta)));
  };
  useEffect(() => {
    if (!playing) return;
    if (position >= last) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setPosition((p) => p + 1), 500);
    return () => clearTimeout(timer);
  }, [playing, position, last]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      } else if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        ["ArrowLeft", "ArrowRight"].includes(e.key)
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        move(e.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose, last]);
  const frame = replay.frames[position];
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="レシート再生"
      className={styles.details}
    >
      <button autoFocus onClick={onClose}>
        閉じる
      </button>
      <h2>レシート再生</h2>
      <p>保存済みの記録 · 通信・ツール実行なし</p>
      {replay.skipped > 0 && (
        <p role="status">不正な記録 {replay.skipped} 件を除外しました</p>
      )}
      <div className={styles.replayControls}>
        <button disabled={position <= 0} onClick={() => move(-1)}>
          前へ
        </button>
        <button
          disabled={!frame || (!playing && position >= last)}
          onClick={() => setPlaying((p) => !p)}
        >
          {playing ? "停止" : "自動再生"}
        </button>
        <button disabled={position >= last} onClick={() => move(1)}>
          次へ
        </button>
        <span aria-live="polite">
          {frame ? position + 1 : 0} / {replay.frames.length}
        </span>
      </div>
      {frame ? (
        <>
          <p>
            {frame.recordedAt} ·{" "}
            {frame.receipt.agentId ? `agent ${frame.receipt.agentId}` : "main"}
          </p>
          <b>
            {frame.receipt.id} · {frame.receipt.provider} ·{" "}
            {frame.receipt.tool ?? frame.receipt.kind}
          </b>
          <p>{frame.receipt.summary}</p>
          <p>
            判断: {frame.receipt.decision ?? "—"} · {frame.receipt.durationMs}ms
          </p>
          <pre>{JSON.stringify(frame.receipt.input ?? {}, null, 2)}</pre>
          <pre>{frame.receipt.output ?? ""}</pre>
        </>
      ) : (
        <p>再生できる記録がありません</p>
      )}
    </div>
  );
}
