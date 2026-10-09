import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { type TranscriptItem } from "../../shared/ipc.js";
import { Logo } from "./Logo.js";
import { McpStatus } from "./McpStatus.js";
import { TodoList } from "./TodoList.js";
import { QuestionChoices } from "./QuestionChoices.js";
import { TextLinks } from "./TextLinks.js";
import styles from "./Transcript.module.css";
import { useFollowScroll } from "../hooks/useFollowScroll.js";

const STATUS = {
  pending: { mark: "…", cls: "wait", label: "running" },
  ok: { mark: "✓", cls: "ok", label: "ok" },
  error: { mark: "✗", cls: "err", label: "error" },
  denied: { mark: "✗", cls: "err", label: "denied" },
} as const;

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
type ToolGroup = { kind: "tool_group"; id: string; tools: ToolItem[] };

/** 専用の進捗・回答UIは隠さず、それ以外の連続した呼び出しだけをまとめる。 */
function groupCommands(
  items: TranscriptItem[],
): (TranscriptItem | ToolGroup)[] {
  const rows: (TranscriptItem | ToolGroup)[] = [];
  for (const item of items) {
    if (
      item.kind !== "tool" ||
      (item.tool === "TodoWrite" && item.todos) ||
      (item.tool === "AskUserQuestion" && item.question)
    ) {
      rows.push(item);
      continue;
    }
    const last = rows.at(-1);
    if (last?.kind === "tool_group") last.tools.push(item);
    else rows.push({ kind: "tool_group", id: item.id, tools: [item] });
  }
  return rows;
}

function ToolCard({ item }: { item: ToolItem }) {
  const st = STATUS[item.status];
  return (
    <details className={styles.call} data-status={item.status}>
      <summary className={styles.head}>
        <span className={styles.k}>
          {item.id} {item.summary}
        </span>
        <span className={styles[st.cls]}>
          {st.mark} {st.label}
        </span>
      </summary>
      {item.detail && <pre className={styles.detail}>{item.detail}</pre>}
    </details>
  );
}

function CommandGroup({ tools }: { tools: ToolItem[] }) {
  const single = tools.length === 1 ? tools[0] : undefined;
  // 1件→複数件でも同じ details を使い、手動で開いた状態を維持する。
  return (
    <details
      className={styles.call}
      data-testid={single ? undefined : "tool-group"}
      data-status={single?.status}
    >
      <summary className={styles.head}>
        <span className={styles.k}>
          {single
            ? `${single.id} ${single.summary}`
            : `コマンド ${tools.length} 件`}
        </span>
        <span className={styles.groupStatus}>
          {(Object.keys(STATUS) as ToolItem["status"][]).map((status) => {
            const count = tools.filter((t) => t.status === status).length;
            const st = STATUS[status];
            return count ? (
              <span key={status} className={styles[st.cls]}>
                {st.mark} {st.label}
                {single ? "" : ` ${count}`}
              </span>
            ) : null;
          })}
        </span>
      </summary>
      {single ? (
        single.detail && <pre className={styles.detail}>{single.detail}</pre>
      ) : (
        <div className={styles.groupContent}>
          {tools.map((item) => (
            <ToolCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </details>
  );
}

export interface TranscriptProps {
  children?: ReactNode;
  officialDefault?: boolean;
  items: TranscriptItem[];
  running: boolean;
  model: string;
  /** /mcp の表示のボタンから送るコマンド */
  onCommand?(text: string): void;
  blocked?: boolean;
  onReply?(text: string): Promise<boolean>;
}

/** モデル出力はReactでescapeする。HTMLは解釈せず、明示的な安全なリンクのみ描画する。 */
export function Transcript({
  items,
  children,
  running,
  model,
  onCommand,
  blocked = false,
  onReply,
  officialDefault = false,
}: TranscriptProps) {
  const pane = useFollowScroll(items);
  const [zoom, setZoom] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const hasItems = items.length > 0;
  useEffect(() => {
    if (!zoom) return;
    if (!hasItems) {
      // 空の会話へ切り替わるとポータルも消えるので、キー制御を残さない。
      setZoom(null);
      return;
    }
    // PromptLine などが実行終了時に focus() しても、背景へ移さない。
    // focusin は同期的に発火するので、次の文字入力より先に引き戻せる。
    const onFocus = (e: FocusEvent) => {
      if (e.target !== closeButton.current) closeButton.current?.focus();
    };
    window.addEventListener("focusin", onFocus, true);
    closeButton.current?.focus();
    // 拡大表示中のキーは、捕捉段階で止めて背後へ伝えない(承認の y / a / n を押させない)
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
      window.removeEventListener("focusin", onFocus, true);
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, [zoom, hasItems]);
  // /mcp の表示は最新のものだけ操作できる(古い表示はその時点の状態)
  const latestMcp = items.findLast((i) => i.kind === "mcp")?.id;
  const latestQuestion = items.findLast(
    (i) =>
      i.kind === "user" ||
      (i.kind === "tool" && ["AskUserQuestion", "StopTask"].includes(i.tool)),
  )?.id;
  if (!items.length && !children)
    return (
      <div ref={pane} className={styles.pane} data-testid="transcript">
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
      ref={pane}
      className={styles.pane}
      data-testid="transcript"
      role="log"
      aria-live="polite"
    >
      {groupCommands(items).map((item) => {
        if (item.kind === "tool_group")
          return <CommandGroup key={item.id} tools={item.tools} />;
        if (item.kind === "tool") {
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
          return <ToolCard key={item.id} item={item} />;
        }
        if (item.kind === "mcp")
          return (
            <div key={item.id}>
              {officialDefault && (
                <p role="status">
                  公式経路は旧MCP操作に未対応です。この記録は閲覧のみです。
                </p>
              )}
              <McpStatus
                servers={item.servers}
                busy={running}
                onCommand={officialDefault ? undefined : onCommand}
                stale={item.id !== latestMcp}
              />
            </div>
          );
        if (item.kind === "notice" && item.presentation !== "assistant")
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
            <div className={styles.bubble}>
              <TextLinks text={item.text} />
            </div>
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
      {children}
      {running && <span className={styles.cursor} aria-hidden />}
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
