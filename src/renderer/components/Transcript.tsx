import { useEffect, useRef } from "react";
import { type TranscriptItem } from "../../shared/ipc.js";
import { Logo } from "./Logo.js";
import { McpStatus } from "./McpStatus.js";
import styles from "./Transcript.module.css";

const STATUS = {
  pending: { mark: "…", cls: "wait", label: "running" },
  ok: { mark: "✓", cls: "ok", label: "ok" },
  error: { mark: "✗", cls: "err", label: "error" },
  denied: { mark: "✗", cls: "err", label: "denied" },
} as const;

export interface TranscriptProps {
  items: TranscriptItem[];
  running: boolean;
  model: string;
  /** /mcp の表示のボタンから送るコマンド */
  onCommand?(text: string): void;
}

/** モデル出力は文字列としてだけ描画する(React が escape する)。HTML / Markdown は解釈しない。 */
export function Transcript({
  items,
  running,
  model,
  onCommand,
}: TranscriptProps) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [items]);
  // /mcp の表示は最新のものだけ操作できる(古い表示はその時点の状態)
  const latestMcp = items.findLast((i) => i.kind === "mcp")?.id;
  if (!items.length)
    return (
      <div className={styles.pane} data-testid="transcript">
        <div className={styles.empty}>
          <div className={styles.logo}>
            <Logo size={44} />
            <span>HARNESS</span>
          </div>
          <div>
            <span style={{ color: "var(--claude)" }}>Claude</span> plans &amp;
            builds, <span style={{ color: "var(--codex)" }}>GPT</span> reviews,{" "}
            <span style={{ color: "var(--code)" }}>code</span> decides.
          </div>
          <div className={styles.hint}>
            # 下の入力欄にメッセージを入力して Enter
          </div>
        </div>
      </div>
    );
  return (
    <div
      className={styles.pane}
      data-testid="transcript"
      role="log"
      aria-live="polite"
    >
      {items.map((item) => {
        if (item.kind === "tool") {
          const st = STATUS[item.status];
          return (
            <div
              key={item.id}
              className={styles.call}
              data-status={item.status}
            >
              <span className={styles.k}>
                {item.id} {item.summary}
              </span>
              <span className={styles[st.cls]}>
                {st.mark} {st.label}
              </span>
            </div>
          );
        }
        if (item.kind === "mcp")
          return (
            <McpStatus
              key={item.id}
              servers={item.servers}
              busy={running}
              onCommand={onCommand}
              stale={item.id !== latestMcp}
            />
          );
        if (item.kind === "notice")
          return (
            <div
              key={item.id}
              className={`${styles.notice} ${styles[item.tone]}`}
              data-phase={item.phase}
            >
              # {item.text}
            </div>
          );
        const user = item.kind === "user";
        return (
          <div
            key={item.id}
            className={`${styles.msg} ${user ? styles.user : styles.assistant}`}
          >
            <div className={styles.who}>
              {user ? (
                <span style={{ color: "var(--dim)" }}>you</span>
              ) : (
                <span
                  style={{
                    color: /^gpt/i.test(model)
                      ? "var(--codex)"
                      : "var(--claude)",
                  }}
                >
                  assistant
                </span>
              )}
            </div>
            <div className={styles.bubble}>{item.text}</div>
          </div>
        );
      })}
      {running && <span className={styles.cursor} aria-hidden />}
      <div ref={end} />
    </div>
  );
}
