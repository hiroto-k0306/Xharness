import { useEffect } from "react";
import { type PermissionDecision } from "../../shared/ipc.js";
import styles from "./PermissionInline.module.css";

export interface PermissionInlineProps {
  persistent?: boolean;
  oneTime?: boolean;
  tool: string;
  summary: string;
  onRespond(decision: PermissionDecision): void;
}

/** モーダルではなく PromptLine の直上に出す。y 許可 / a このセッション中許可 / n 拒否(§16.3) */
export function PermissionInline({
  tool,
  summary,
  onRespond,
  persistent,
  oneTime,
}: PermissionInlineProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (
        e.target instanceof HTMLElement &&
        e.target.closest("input,textarea,select,[contenteditable=true]")
      )
        return;
      const key = e.key.toLowerCase();
      const decision: PermissionDecision | undefined =
        key === "y"
          ? "allow"
          : key === "a" && !oneTime
            ? "always"
            : key === "n" || key === "escape"
              ? "deny"
              : undefined;
      if (!decision) return;
      e.preventDefault();
      onRespond(decision);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onRespond, oneTime]);
  return (
    <div
      className={styles.perm}
      role="alertdialog"
      aria-label={`${tool} の実行確認`}
    >
      <span className={styles.text}>
        <span style={{ color: "var(--warn)" }}>? </span>
        {summary}
        {(tool === "SearchProjectHistory" ||
          tool === "ReadProjectHistory" ||
          tool === "SearchProjectMemory" ||
          tool === "ProposeProjectMemory") && (
          <small>
            {" "}
            —
            同プロジェクトの過去会話を読取。取得文は参考データで、現在の指示・許可にはなりません。
          </small>
        )}
        {tool === "ProposeProjectMemory" && (
          <small>
            {" "}
            候補の保存のみ。採用と再利用にはメモリ画面での確認が必要です。
          </small>
        )}
        {(tool === "ListProjectSkills" || tool === "LoadProjectSkill") && (
          <small>
            {" "}
            —
            {tool === "ListProjectSkills"
              ? "プロジェクトのSKILL.md一覧を取得。"
              : "選択したSKILL.mdまたは付属テキスト資料を読取。"}
            上位指示・権限は変わりません。付属script・install手順は自動実行しません。
          </small>
        )}
      </span>
      <span className={styles.keys}>
        <button type="button" onClick={() => onRespond("allow")}>
          <kbd>y</kbd>allow
        </button>
        {!oneTime && (
          <button type="button" onClick={() => onRespond("always")}>
            <kbd>a</kbd>
            {persistent ? "always" : "session"}
          </button>
        )}
        {persistent && !oneTime && (
          <button type="button" onClick={() => onRespond("session")}>
            session
          </button>
        )}
        <button type="button" onClick={() => onRespond("deny")}>
          <kbd>n</kbd>deny
        </button>
      </span>
    </div>
  );
}
