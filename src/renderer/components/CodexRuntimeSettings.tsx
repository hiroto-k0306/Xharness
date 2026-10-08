import { useState } from "react";
import type {
  OfficialWorkflowCommand,
  OfficialWorkflowView,
} from "../../shared/official-workflow.js";

export function CodexRuntimeSettings({
  connection,
  disabled,
  send,
}: {
  connection: OfficialWorkflowView["connection"];
  disabled: boolean;
  send: (command: OfficialWorkflowCommand) => Promise<void>;
}) {
  const [path, setPath] = useState("");
  return (
    <section aria-label="Codex実行環境">
      <p>
        Codex：
        {connection?.codexMode === "fixed"
          ? "指定版を固定"
          : "アプリ同梱版へ自動追従"}
      </p>
      {connection?.codexPackage && (
        <p>登録済みアプリ：{connection.codexPackage}</p>
      )}
      {connection?.codexPath && <p>参照先：{connection.codexPath}</p>}
      <label>
        公式Codex実行パス
        <input
          aria-label="公式Codex実行パス"
          value={path}
          placeholder="障害時のみ：フォルダーまたはcodex.exeの絶対パス"
          onChange={(event) => setPath(event.target.value)}
        />
      </label>
      <button
        disabled={disabled || !path.trim()}
        onClick={() =>
          void send({ action: "configure", codexPath: path.trim() })
        }
      >
        公式接続設定を保存
      </button>
      <button
        disabled={disabled}
        onClick={() => void send({ action: "configure_auto" })}
      >
        同梱版の自動追従に戻す
      </button>
      <p>
        通常は登録済みCodexアプリの同梱CLIを使います。障害時の指定版は、自動追従へ戻すまで固定します。実行中のタスクは切り替えません。
      </p>
      <p role="status">{connection?.message}</p>
    </section>
  );
}
