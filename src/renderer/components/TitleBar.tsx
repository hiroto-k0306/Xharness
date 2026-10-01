import { Logo } from "./Logo.js";
import { type ReactNode } from "react";
import styles from "./TitleBar.module.css";

export interface TitleBarProps {
  usage?: ReactNode;
  workspaceName?: string;
  branch?: string;
  pickerOpen: boolean;
  onTogglePicker(): void;
  fake: boolean;
}

/** フレームレス: ウィンドウ操作ボタンは titleBarOverlay(OS 標準)が右端に重なる(§17.2) */
export function TitleBar(props: TitleBarProps) {
  return (
    <header className={styles.bar} data-testid="titlebar">
      <div className={styles.brand}>
        <Logo size={14} />
        <span>XHARNESS</span>
      </div>
      <button
        type="button"
        className={`${styles.ws} ${props.pickerOpen ? styles.open : ""}`}
        onClick={props.onTogglePicker}
        title="ワークスペースを切り替え (Ctrl+O)"
        aria-expanded={props.pickerOpen}
        aria-haspopup="dialog"
      >
        <span aria-hidden>▤</span>
        <span>{props.workspaceName ?? "no workspace"}</span>
        {props.branch && (
          <span className={styles.branch}>⎇ {props.branch}</span>
        )}
        <span className={styles.caret}>▾</span>
      </button>
      <div className={styles.spacer} />
      {props.usage}
      {props.fake && (
        <span className={styles.fake} title="--fake: 通信しません">
          FAKE
        </span>
      )}
      <div className={styles.conn} aria-label="providers">
        <span>
          claude
          <i className={styles.dot} style={{ background: "var(--claude)" }} />
        </span>
        <span>
          codex
          <i className={styles.dot} style={{ background: "var(--codex)" }} />
        </span>
      </div>
      <div className={styles.overlay} aria-hidden />
    </header>
  );
}
