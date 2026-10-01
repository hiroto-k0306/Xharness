import { useEffect, useRef, useState } from "react";
import styles from "./PromptLine.module.css";

export interface PromptLineProps {
  cwdLabel: string;
  running: boolean;
  /** 権限待ち。入力は止め、y / a / n を PermissionInline が受ける */
  blocked: boolean;
  modelLabel: string;
  modelColor: string;
  onSubmit(text: string): void;
}

/** `name ❯ ` 形式の入力欄。Enter 送信 / Shift+Enter 改行(実行中の Esc 中断は App が受ける) */
export function PromptLine(p: PromptLineProps) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const disabled = p.running || p.blocked;
  useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [disabled]);
  return (
    <div className={`${styles.prompt} ${p.blocked ? styles.blocked : ""}`}>
      <span className={styles.cwd}>{p.cwdLabel}</span>
      <span className={styles.gt}>❯</span>
      <textarea
        ref={ref}
        className={styles.input}
        rows={1}
        value={text}
        disabled={disabled}
        aria-label="prompt"
        placeholder={
          p.blocked
            ? "# 権限の確認待ち"
            : p.running
              ? "# 実行中… Esc で中断"
              : ""
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // 日本語入力の変換確定の Enter は送信しない
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!text.trim()) return;
            p.onSubmit(text);
            setText("");
          }
        }}
      />
      <span className={styles.chip} title="モデルの切替は Phase 5(ModelPicker)">
        <i className={styles.dot} style={{ background: p.modelColor }} />
        {p.modelLabel}
      </span>
      <span
        className={styles.chip}
        title="権限は全ツール ask(Phase 4 でルール化)"
      >
        ask
      </span>
    </div>
  );
}
