import { useState } from "react";
import { type QuotaPauseView } from "../../shared/quota-resume.js";
import styles from "./QuotaPause.module.css";

export function QuotaPause({
  pause,
  sessionId,
}: {
  pause: QuotaPauseView;
  sessionId: string;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const action = async (action: "enable" | "cancel" | "now") => {
    setBusy(true);
    try {
      const result = await window.harness.command({
        type: "quota_resume",
        sessionId,
        action,
      });
      setError(result.ok ? undefined : result.error);
    } catch {
      setError("枠待ちの操作に失敗しました。");
    } finally {
      setBusy(false);
    }
  };
  const active = ["paused", "manual", "waiting", "running"].includes(
    pause.state,
  );
  return (
    <section
      className={styles.panel}
      aria-label="利用枠の再開予定"
      role="status"
    >
      <p>
        利用枠待ち: {pause.state} · {pause.provider}/{pause.model} ·{" "}
        {pause.scope}
      </p>
      <p>{pause.reason}</p>
      <small>
        タスク: {pause.taskId ?? "不明"} · 段階: {pause.phase ?? "不明"}
      </small>
      <small>
        次の確認:{" "}
        {pause.nextCheckAt === undefined
          ? "不明（手動確認）"
          : new Date(pause.nextCheckAt).toLocaleString()}{" "}
        · 有効期限: {new Date(pause.expiresAt).toLocaleString()} · 再開試行:{" "}
        {pause.attempts}/3
      </small>
      {active && (
        <p>
          {pause.eligible && pause.state !== "running" && (
            <>
              {pause.nextCheckAt !== undefined && pause.state !== "waiting" && (
                <button disabled={busy} onClick={() => void action("enable")}>
                  条件を再確認して自動再開を有効化
                </button>
              )}
              <button disabled={busy} onClick={() => void action("now")}>
                今、条件を再確認して続行
              </button>
            </>
          )}
          <button disabled={busy} onClick={() => void action("cancel")}>
            再開を取り消す
          </button>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
