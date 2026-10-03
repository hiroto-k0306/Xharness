import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type TranscriptItem } from "../../shared/ipc.js";
import { Logo } from "./Logo.js";
import { McpStatus } from "./McpStatus.js";
import { TodoList } from "./TodoList.js";
import { QuestionChoices } from "./QuestionChoices.js";
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
  blocked?: boolean;
  onReply?(text: string): Promise<boolean>;
}

/** モデル出力は文字列としてだけ描画する(React が escape する)。HTML / Markdown は解釈しない。 */
export function Transcript({
  items,
  running,
  model,
  onCommand,
  blocked = false,
  onReply,
}: TranscriptProps) {
  const end = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!zoom) return;
    closeButton.current?.focus();
    // 拡大表示中のキーは、捕捉段階で止めて背後へ伝えない(App の Esc 中断や承認の y / a / n を押させない)
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") setZoom(null);
      else if (e.key === "Tab") {
        // 操作できるのは閉じるボタンだけなので、フォーカスをそこにとどめる
        e.preventDefault();
        closeButton.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, [zoom]);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [items]);
  // /mcp の表示は最新のものだけ操作できる(古い表示はその時点の状態)
  const latestMcp = items.findLast((i) => i.kind === "mcp")?.id;
  const latestQuestion = items.findLast(
    (i) =>
      i.kind === "user" ||
      (i.kind === "tool" && ["AskUserQuestion", "StopTask"].includes(i.tool)),
  )?.id;
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
          if (item.tool === "TodoWrite" && item.status === "ok" && item.todos)
            return <TodoList key={item.id} todos={item.todos} />;
          if (
            item.tool === "AskUserQuestion" &&
            item.status === "ok" &&
            item.question
          )
            return (
              <QuestionChoices
                key={item.id}
                question={item.question}
                disabled={running || blocked || item.id !== latestQuestion}
                onReply={onReply}
              />
            );
          return (
            <details
              key={item.id}
              className={styles.call}
              data-status={item.status}
            >
              <summary className={styles.head}>
                <span className={styles.k}>
                  {item.id} {item.summary}
                </span>
                <span className={styles[st.cls]}>
                  {st.mark} {st.label}
                </span>
              </summary>
              {item.detail && (
                <pre className={styles.detail}>{item.detail}</pre>
              )}
            </details>
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
            {item.kind === "user" &&
              item.images?.map((image, i) => (
                <button
                  key={i}
                  type="button"
                  className={styles.thumb}
                  aria-label={`添付画像 ${i + 1} を拡大`}
                  onClick={(e) => {
                    opener.current = e.currentTarget;
                    setZoom(`data:${image.mediaType};base64,${image.data}`);
                  }}
                >
                  <img
                    alt={`添付画像 ${i + 1}`}
                    src={`data:${image.mediaType};base64,${image.data}`}
                    style={{ maxWidth: 240, maxHeight: 180 }}
                  />
                </button>
              ))}
          </div>
        );
      })}
      {running && <span className={styles.cursor} aria-hidden />}
      <div ref={end} />
      {zoom &&
        createPortal(
          <div
            className={styles.overlay}
            role="dialog"
            aria-modal="true"
            aria-label="画像の拡大表示"
            data-testid="image-overlay"
            onClick={() => setZoom(null)}
          >
            <button
              ref={closeButton}
              type="button"
              className={styles.close}
              aria-label="閉じる"
              onClick={() => setZoom(null)}
            >
              ×
            </button>
            <img
              className={styles.zoomed}
              alt="拡大した添付画像"
              src={zoom}
              onClick={(e) => e.stopPropagation()}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
