import { type McpServerView } from "../../shared/ipc.js";
import styles from "./McpStatus.module.css";

const LABEL: Record<McpServerView["status"], string> = {
  connected: "接続中",
  failed: "接続失敗",
  unapproved: "未承認",
  rejected: "拒否",
  needs_auth: "要認可",
};

export interface McpStatusProps {
  servers: McpServerView[];
  /** 実行中は操作を止める */
  busy: boolean;
  /** `/mcp reconnect <server>` などを送る */
  onCommand?(text: string): void;
}

/** /mcp の表示(§25.8)。サーバーごとの状態と、再接続・承認の取り消し・ログアウト */
export function McpStatus({ servers, busy, onCommand }: McpStatusProps) {
  return (
    <div className={styles.box} data-testid="mcp-status">
      <div className={styles.title}># MCP サーバー</div>
      {servers.length === 0 && (
        <div className={styles.counts}>.mcp.json にサーバーがありません</div>
      )}
      {servers.map((s) => (
        <div key={s.name} className={styles.row} data-server={s.name}>
          <span className={styles.name}>{s.name}</span>
          <span className={styles.counts}>{s.type}</span>
          <span className={styles[s.status]}>{LABEL[s.status]}</span>
          {s.status === "connected" && (
            <span className={styles.counts}>
              ツール {s.tools} · リソース {s.resources ?? 0} · プロンプト{" "}
              {s.prompts ?? 0}
            </span>
          )}
          {onCommand && (
            <span className={styles.actions}>
              <button
                type="button"
                disabled={busy}
                onClick={() => onCommand(`/mcp reconnect ${s.name}`)}
              >
                {s.status === "connected" ? "再接続" : "接続"}
              </button>
              {["connected", "rejected", "failed", "needs_auth"].includes(
                s.status,
              ) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onCommand(`/mcp reset ${s.name}`)}
                >
                  承認を取り消す
                </button>
              )}
              {s.oauth && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onCommand(`/mcp logout ${s.name}`)}
                >
                  ログアウト
                </button>
              )}
            </span>
          )}
          {s.error && <span className={styles.error}>{s.error}</span>}
        </div>
      ))}
    </div>
  );
}
