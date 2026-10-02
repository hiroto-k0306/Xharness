import { useState } from "react";
import {
  type AuthenticationView,
  type ProviderName,
} from "../../shared/ipc.js";
import styles from "./AuthenticationPanel.module.css";

const labels: Record<AuthenticationView["status"], string> = {
  missing: "未認証",
  expired: "期限切れ",
  available: "資格情報あり",
  authenticating: "認証中",
  rejected: "再認証が必要",
  error: "認証未完了",
};
export function AuthenticationPanel({
  views,
  disabled,
  command,
}: {
  views: AuthenticationView[];
  disabled: boolean;
  command: (
    type: "authenticate" | "refresh_auth",
    provider?: ProviderName,
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const busy =
    disabled || pending || views.some((v) => v.status === "authenticating");
  async function run(
    type: "authenticate" | "refresh_auth",
    provider?: ProviderName,
  ) {
    setPending(true);
    setError("");
    try {
      const result = await command(type, provider);
      if (!result.ok) setError(result.error ?? "認証操作に失敗しました");
    } catch {
      setError("認証操作に失敗しました");
    } finally {
      setPending(false);
    }
  }
  const needsAuthentication = views.filter((v) => v.status !== "available");
  if (!needsAuthentication.length) return null;
  return (
    <section className={styles.panel} aria-label="モデルの認証">
      <div className={styles.heading}>
        <strong>モデルの認証</strong>
        <button disabled={busy} onClick={() => void run("refresh_auth")}>
          状態を再確認
        </button>
      </div>
      {needsAuthentication.map((v) => (
        <div key={v.provider} className={styles.row} data-status={v.status}>
          <span>
            {v.provider === "claude" ? "Claude" : "Codex"} · {labels[v.status]}
          </span>
          {v.status !== "available" && (
            <button
              className={styles.authorize}
              disabled={busy}
              onClick={() => void run("authenticate", v.provider)}
            >
              {v.provider === "claude" ? "Claude" : "Codex"}の認証・更新を許可
            </button>
          )}
          {v.message && (
            <span className={styles.message} role="status">
              {v.message}
            </span>
          )}
        </div>
      ))}
      {views.some((v) => v.status !== "available") && (
        <p>
          公式CLIで認証・更新しますか？
          許可後に開く公式CLIとブラウザでログインしてください。キャンセルすると認証は行いません。
        </p>
      )}
      <p>
        資格情報ありは保存ファイルの確認結果です。提供元での有効性は送信時に確認します。
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
