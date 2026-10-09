import { useEffect, useRef, useState } from "react";
import type {
  OfficialWorkflowCommand,
  OfficialWorkflowView,
} from "../../shared/official-workflow.js";
import { CodexRuntimeSettings } from "./CodexRuntimeSettings.js";
import { ClaudeSdkStatus } from "./ClaudeSdkStatus.js";

/** Runtime configuration is separate from conversation results and approvals. */
export function OfficialRuntimeSettings() {
  const [view, setView] = useState<OfficialWorkflowView>();
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const sending = useRef(false);
  useEffect(() => {
    let live = true;
    const poll = () =>
      void window.harness
        .officialWorkflow?.({ action: "list" })
        .then((v) => {
          if (live) setView(v);
        })
        .catch(() => {
          if (live) setError("接続設定を取得できません");
        });
    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const send = async (command: OfficialWorkflowCommand) => {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setError("");
    try {
      const result = await window.harness.officialWorkflow?.(command);
      if (result) setView(result);
    } catch {
      setError("設定を保存できませんでした。自動再送はしていません。");
    } finally {
      sending.current = false;
      setPending(false);
    }
  };
  return (
    <details aria-label="公式接続設定">
      <summary>設定 · 公式実行環境と通知</summary>
      {error && <p role="alert">{error}</p>}
      <CodexRuntimeSettings
        connection={view?.connection}
        disabled={pending || !!view?.activeId}
        send={send}
      />
      <ClaudeSdkStatus runtime={view?.claudeRuntime} />
      <p>
        通知が表示されない場合は、Windowsの設定 → システム →
        通知でXHarnessを確認してください。通知が使えなくてもチャットで操作を続けられます。アプリは通知設定を変更しません。
      </p>
    </details>
  );
}
