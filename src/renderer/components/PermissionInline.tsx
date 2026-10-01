import { useEffect } from "react";
import { type PermissionDecision } from "../../shared/ipc.js";
import styles from "./PermissionInline.module.css";

export interface PermissionInlineProps {
  persistent?: boolean;
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
}: PermissionInlineProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const key = e.key.toLowerCase();
      const decision: PermissionDecision | undefined =
        key === "y"
          ? "allow"
          : key === "a"
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
  }, [onRespond]);
  return (
    <div
      className={styles.perm}
      role="alertdialog"
      aria-label={`${tool} の実行確認`}
    >
      <span className={styles.text}>
        <span style={{ color: "var(--warn)" }}>? </span>
        {summary}
      </span>
      <span className={styles.keys}>
        <button type="button" onClick={() => onRespond("allow")}>
          <kbd>y</kbd>allow
        </button>
        <button type="button" onClick={() => onRespond("always")}>
          <kbd>a</kbd>{persistent ? "always" : "session"}
        </button>
        {persistent && <button type="button" onClick={() => onRespond("session")}>session</button>}
        <button type="button" onClick={() => onRespond("deny")}>
          <kbd>n</kbd>deny
        </button>
      </span>
    </div>
  );
}
