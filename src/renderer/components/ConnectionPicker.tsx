import { useEffect, useState } from "react";
import type {
  ConnectionChoice,
  ConnectionView,
} from "../../shared/connections.js";
import styles from "./Workflow.module.css";
const statusLabels = {
  unconfigured: "未設定",
  available: "利用可能",
  needs_auth: "認可必要",
};
export function ConnectionPicker({
  views,
  current,
  disabled,
  command,
}: {
  views: ConnectionView[];
  current: ConnectionChoice;
  disabled: boolean;
  command(
    action: "apply" | "check" | "cancel",
    mode: ConnectionChoice,
  ): Promise<{ ok: boolean; error?: string }>;
}) {
  const [open, setOpen] = useState(false),
    [selected, setSelected] = useState(current),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    setSelected(current);
  }, [current]);
  const close = () => {
    if (busy) void command("cancel", selected);
    setOpen(false);
    setSelected(current);
    setError("");
  };
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        close();
      }
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  });
  const view = views.find((v) => v.mode === selected);
  return (
    <>
      <button
        disabled={disabled}
        onClick={() => {
          setSelected(current);
          setOpen(true);
        }}
      >
        接続方式: {views.find((v) => v.mode === current)?.label ?? current}
      </button>
      {open && (
        <div role="dialog" aria-label="接続方式" className={styles.picker}>
          <label>
            このセッションの接続
            <select
              aria-label="接続方式"
              value={selected}
              disabled={busy || disabled}
              onChange={(e) => setSelected(e.target.value as ConnectionChoice)}
            >
              {views.map((v) => (
                <option key={v.mode} value={v.mode}>
                  {v.label} / {statusLabels[v.status]}
                </option>
              ))}
            </select>
          </label>
          {view && (
            <p role="status">
              {statusLabels[view.status]} — {view.reason}
            </p>
          )}
          <p>
            新接続は通常テキストのAgent
            Loopのみ。自動選択・レビュー段階・補助通信は未対応です。方式変更は空の新規セッションで行います。
          </p>
          <button
            disabled={busy || disabled}
            onClick={() => {
              setBusy(true);
              void command("apply", selected)
                .then((r) => {
                  if (r.ok) setOpen(false);
                  else setError(r.error ?? "選択に失敗しました。");
                })
                .finally(() => setBusy(false));
            }}
          >
            接続を適用
          </button>
          {selected.startsWith("claude-") && (
            <button
              disabled={busy || disabled}
              onClick={() => {
                setBusy(true);
                void command("check", selected)
                  .then((r) => {
                    if (!r.ok) setError(r.error ?? "確認に失敗しました。");
                  })
                  .finally(() => setBusy(false));
              }}
            >
              公式SDK接続を確認
            </button>
          )}
          {error && <p role="alert">{error}</p>}
          <button onClick={close}>キャンセル</button>
        </div>
      )}
    </>
  );
}
