import { useEffect, useRef, useState } from "react";
import { permissionModeLabels } from "../../shared/permission-modes.js";
import styles from "./PromptLine.module.css";
import {
  attachmentInfo,
  imageInfo,
  MAX_IMAGE_BYTES,
  IMAGE_ERROR,
  DEFAULT_IMAGES,
  type ImageAttachment,
} from "../../shared/images.js";

export interface PromptLineProps {
  maxImages?: number;
  sessionId?: string | null;
  imageInput?: boolean;
  onStop?(): void;
  onModel?(): void;
  mode?: "default" | "acceptEdits" | "plan";
  readOnly?: boolean;
  onMode?(mode: "default" | "acceptEdits" | "plan"): void;
  cwdLabel: string;
  running: boolean;
  /** 権限待ち。入力は止め、y / a / n を PermissionInline が受ける */
  blocked: boolean;
  modelLabel: string;
  modelColor: string;
  /** false を返したら(送信を断られたら)、入力欄が空のままなら文を戻す */
  onSubmit(
    text: string,
    images?: ImageAttachment[],
  ): void | boolean | Promise<boolean | void>;
  /** `/` で始まる入力の補完候補(/mcp と MCP のプロンプト。§25.8) */
  suggestions?: Suggestion[];
}

export interface Suggestion {
  /** 入力欄に入れる文字列 */
  value: string;
  /** 引数の形(例: `<file> [focus]`) */
  args?: string;
  description?: string;
}

/** 入力中のコマンド名(最初の空白より前)に前方一致する候補。空白を打ったら閉じる */
export function matchSuggestions(
  text: string,
  all: Suggestion[] | undefined,
): Suggestion[] {
  if (!all?.length || !text.startsWith("/") || /\s/.test(text)) return [];
  const query = text.toLowerCase();
  return all
    .filter((s) => s.value.toLowerCase().startsWith(query) && s.value !== text)
    .slice(0, 8);
}

/** `name ❯ ` 形式の入力欄。Enter 送信 / Shift+Enter 改行(実行中の Esc 中断は App が受ける) */
export function PromptLine(p: PromptLineProps) {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState(0);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [imageError, setImageError] = useState("");
  const [reading, setReading] = useState(false);
  const sending = useRef(false);
  const attachmentGeneration = useRef(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const disabled = p.running || p.blocked || reading;
  useEffect(() => {
    attachmentGeneration.current++;
    if (!sending.current) {
      setImages([]);
      setImageError("");
      setReading(false);
    }
  }, [p.sessionId]);
  const attach = async (files: File[]) => {
    if (disabled) return;
    const generation = attachmentGeneration.current;
    setReading(true);
    setImageError("");
    if (
      images.length + files.length >
      (p.maxImages ?? DEFAULT_IMAGES.maxPerMessage)
    ) {
      setReading(false);
      setImageError(
        `画像の添付は1メッセージ${p.maxImages ?? DEFAULT_IMAGES.maxPerMessage}枚までです。`,
      );
      return;
    }
    try {
      const added = await Promise.all(
        files.map(
          (file) =>
            new Promise<ImageAttachment>((resolve, reject) => {
              if (!file.size || file.size > MAX_IMAGE_BYTES)
                return reject(new Error(IMAGE_ERROR));
              const reader = new FileReader();
              reader.onerror = () => reject(new Error(IMAGE_ERROR));
              reader.onload = () => {
                try {
                  const match = /^data:([^;]+);base64,(.*)$/s.exec(
                    String(reader.result),
                  );
                  if (!match) throw new Error(IMAGE_ERROR);
                  const image = { mediaType: match[1]!, data: match[2]! };
                  // Some file managers omit MIME. Detect it from content rather than the extension.
                  image.mediaType = imageInfo(
                    Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0)),
                  ).mediaType;
                  attachmentInfo(image);
                  resolve(image);
                } catch {
                  reject(new Error(IMAGE_ERROR));
                }
              };
              reader.readAsDataURL(file);
            }),
        ),
      );
      if (generation === attachmentGeneration.current)
        setImages((now) =>
          [...now, ...added].slice(
            0,
            p.maxImages ?? DEFAULT_IMAGES.maxPerMessage,
          ),
        );
    } catch {
      if (generation === attachmentGeneration.current)
        setImageError(IMAGE_ERROR);
    } finally {
      if (generation === attachmentGeneration.current) setReading(false);
    }
  };
  const matches = matchSuggestions(text, p.suggestions);
  const accept = (s: Suggestion) => {
    setText(s.args ? `${s.value} ` : s.value);
    setSelected(0);
    ref.current?.focus();
  };
  useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [disabled]);
  return (
    <div
      className={`${styles.prompt} ${p.blocked ? styles.blocked : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        void attach(Array.from(e.dataTransfer.files));
      }}
    >
      <div className={styles.attachments}>
        {images.map((image, i) => (
          <div key={i}>
            <img
              alt={`添付画像 ${i + 1}`}
              src={`data:${image.mediaType};base64,${image.data}`}
            />
            <span>
              {image.mediaType} ·{" "}
              {Math.floor((image.data.length * 3) / 4) -
                (image.data.endsWith("==")
                  ? 2
                  : image.data.endsWith("=")
                    ? 1
                    : 0)}{" "}
              bytes
            </span>
            <button
              type="button"
              disabled={disabled}
              aria-label={`添付画像 ${i + 1}を削除`}
              onClick={() => setImages((now) => now.filter((_, n) => n !== i))}
            >
              ×
            </button>
          </div>
        ))}
        {!!images.length && p.imageInput !== true && (
          <span role="status">
            {p.imageInput === false
              ? "このモデルは画像入力に対応していません。モデルを切り替えてください。"
              : "このモデルの画像入力対応は未確認です。"}
          </span>
        )}
        {imageError && <span role="alert">{imageError}</span>}
      </div>
      {matches.length > 0 && !disabled && (
        <ul className={styles.suggest} role="listbox" aria-label="commands">
          {matches.map((s, i) => (
            <li
              key={s.value}
              role="option"
              aria-selected={i === selected}
              className={i === selected ? styles.selected : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(s);
              }}
            >
              <span className={styles.cmd}>{s.value}</span>
              {s.args && <span className={styles.args}> {s.args}</span>}
              {s.description && (
                <span className={styles.desc}> — {s.description}</span>
              )}
            </li>
          ))}
        </ul>
      )}
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
        onChange={(e) => {
          setText(e.target.value);
          setSelected(0);
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files).filter((file) =>
            file.type.startsWith("image/"),
          );
          if (files.length) {
            e.preventDefault();
            void attach(files);
          }
        }}
        onKeyDown={(e) => {
          // 日本語入力の変換確定の Enter は送信しない
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          // 補完: Tab で選んだ候補を入れる、↑↓ で選ぶ
          if (matches.length) {
            if (e.key === "Tab") {
              e.preventDefault();
              accept(matches[Math.min(selected, matches.length - 1)]!);
              return;
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setSelected((i) => (i + step + matches.length) % matches.length);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if ((!text.trim() && !images.length) || disabled || sending.current)
              return;
            const sent = text;
            const attached = images;
            sending.current = true;
            setImages([]);
            setText("");
            void Promise.resolve(
              attached.length ? p.onSubmit(sent, attached) : p.onSubmit(sent),
            )
              .catch(() => false)
              .then((ok) => {
                if (ok === false) {
                  setText((now) => (now === "" ? sent : now));
                  setImages((now) => [...attached, ...now]);
                }
                sending.current = false;
              });
          }
        }}
      />
      <button
        type="button"
        className={styles.chip}
        title="モデル切替 (Ctrl+M)"
        onClick={p.onModel}
        aria-label="モデル切替"
      >
        <i className={styles.dot} style={{ background: p.modelColor }} />
        {p.modelLabel}
      </button>
      {p.mode ? (
        <select
          className={styles.chip}
          aria-label="permission mode"
          disabled={p.readOnly}
          value={p.mode}
          title="権限モード（Shift+Tab）"
          style={{
            color: p.mode === "acceptEdits" ? "var(--warn)" : "var(--dim)",
          }}
          onChange={(e) =>
            p.onMode?.(e.target.value as "default" | "acceptEdits" | "plan")
          }
        >
          <option value="default">{permissionModeLabels.default}</option>
          <option value="acceptEdits">
            {permissionModeLabels.acceptEdits}
          </option>
          <option value="plan">{permissionModeLabels.plan}</option>
        </select>
      ) : (
        <span
          className={styles.chip}
          title="権限は全ツール ask(Phase 4 でルール化)"
        >
          ask
        </span>
      )}
      {p.running && p.onStop && (
        <button
          type="button"
          className={styles.stop}
          onClick={p.onStop}
          aria-label="停止"
          title="停止（Esc）"
        >
          <span aria-hidden="true">■</span>
        </button>
      )}
    </div>
  );
}
