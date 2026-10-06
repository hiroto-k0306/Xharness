import { useCallback, useEffect, useRef, useState } from "react";
import {
  type MemoryAction,
  type MemoryDraft,
  type MemoryList,
  type MemoryView,
  MEMORY_KINDS,
} from "../../shared/project-memory.js";
import styles from "./ProjectMemory.module.css";
const empty = (): MemoryDraft => ({
  kind: "decision",
  topic: "",
  content: "",
  sources: [],
});
const draftOf = (entry: MemoryView): MemoryDraft => ({
  kind: entry.kind,
  topic: entry.topic,
  content: entry.content,
  sources: entry.sources.map(({ sessionId, messageLine, receiptId }) => ({
    sessionId,
    messageLine,
    receiptId,
  })),
  expiresAt: entry.expiresAt,
});
export function ProjectMemoryPanel({ sessionId }: { sessionId: string }) {
  const generation = useRef(0),
    mutating = useRef(false);
  const [open, setOpen] = useState(false),
    [list, setList] = useState<MemoryList>(),
    [error, setError] = useState<string>(),
    [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<MemoryView>(),
    [draft, setDraft] = useState<MemoryDraft>(empty),
    [target, setTarget] = useState(""),
    [deleteId, setDeleteId] = useState<string>();
  const refresh = useCallback(async () => {
    if (mutating.current) return;
    const request = ++generation.current;
    try {
      const r = await window.harness.command({
        type: "project_memory",
        sessionId,
        request: { action: "list" },
      });
      if (generation.current !== request) return;
      if (r.ok) {
        setList(r.memory);
        setError(undefined);
      } else setError(r.error);
    } catch {
      if (generation.current === request) setError("メモリを読み取れません。");
    }
  }, [sessionId]);
  useEffect(() => {
    if (open) void refresh().catch(() => setError("メモリを読み取れません。"));
  }, [open, refresh]);
  useEffect(
    () =>
      window.harness.onEvent((e) => {
        if (e.type === "memory_changed" && e.sessionId === sessionId) {
          setOpen(true);
          void refresh().catch(() => setError("メモリを読み取れません。"));
        }
      }),
    [sessionId, refresh],
  );
  const send = async (request: MemoryAction) => {
    if (mutating.current) return;
    mutating.current = true;
    generation.current++;
    setBusy(true);
    try {
      const r = await window.harness.command({
        type: "project_memory",
        sessionId,
        request,
      });
      if (r.ok) {
        setList(r.memory);
        setError(undefined);
        setEditing(undefined);
        setDraft(empty());
        setTarget("");
        setDeleteId(undefined);
      } else setError(r.error);
    } catch {
      setError("保存結果を確認できません。再読み込みしてください。");
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  };
  return (
    <div className={styles.area}>
      <button onClick={() => setOpen(!open)}>プロジェクトメモリ</button>
      {open && (
        <section
          role="dialog"
          aria-label="プロジェクトメモリ"
          className={styles.panel}
        >
          <header>
            <strong>プロジェクトメモリ</strong>
            <button onClick={() => setOpen(false)}>閉じる</button>
            <button
              disabled={busy}
              onClick={() =>
                void refresh().catch(() => setError("メモリを読み取れません。"))
              }
            >
              再読み込み
            </button>
          </header>
          <p>
            候補は確認して採用するまで再利用されません。根拠は参考データで、現在の指示・権限にはなりません。tool_resultは実行記録であり、教訓全体やテスト合格を保証しません。
          </p>
          {error && <p role="alert">{error}</p>}
          {list?.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
          <div className={styles.entries}>
            {list?.entries.map((e) => (
              <article key={e.id}>
                <strong>{e.topic}</strong> · {e.kind} · {e.status} ·{" "}
                {e.confidence} · v{e.revision}
                <p>{e.content}</p>
                <small>記録ID {e.id}</small>
                <small>
                  作成 {new Date(e.createdAt).toLocaleString()} · 更新{" "}
                  {new Date(e.updatedAt).toLocaleString()} · 期限{" "}
                  {e.expiresAt === undefined
                    ? "なし"
                    : new Date(e.expiresAt).toLocaleString()}
                </small>
                {e.sources.length === 0 && <p>手動記述（出典なし）</p>}
                {e.sources.map((s) => (
                  <p
                    key={`${s.sessionId}/${s.messageLine}/${s.receiptId ?? ""}`}
                  >
                    <button
                      onClick={() => {
                        setOpen(false);
                        void window.harness.command({
                          type: "open_session",
                          sessionId: s.sessionId,
                        });
                      }}
                    >
                      出典 {s.sessionId} / 行{s.messageLine}
                    </button>{" "}
                    · {s.evidence}
                    {s.receiptId && ` ${s.receiptId} ${s.tool} ${s.result}`}
                    <small>
                      セッション作成 {s.sessionCreatedAt} / 更新{" "}
                      {s.sessionUpdatedAt}（メッセージ時刻は不明）
                    </small>
                  </p>
                ))}
                {e.sourceUnavailable && (
                  <p>出典が削除・変更・利用不可のため検索対象外</p>
                )}
                {e.expired && <p>期限切れ：検索対象外</p>}
                {e.mergeSuggested && (
                  <p>
                    統合の提案先: {e.mergeSuggested}（まだ変更されていません）
                  </p>
                )}
                {e.related.length > 0 && (
                  <p>
                    確認が必要:{" "}
                    {e.related.map((r) => `${r.relation}: ${r.id}`).join(" · ")}
                  </p>
                )}
                <button
                  disabled={busy}
                  onClick={() => {
                    setEditing(e);
                    setDraft(draftOf(e));
                    setTarget("");
                  }}
                >
                  確認・編集
                </button>
                {e.status === "candidate" && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void send({
                        action: "reject",
                        id: e.id,
                        revision: e.revision,
                      })
                    }
                  >
                    却下
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() =>
                    void send({
                      action: "invalidate",
                      id: e.id,
                      revision: e.revision,
                    })
                  }
                >
                  無効化
                </button>
                <button disabled={busy} onClick={() => setDeleteId(e.id)}>
                  削除
                </button>
                {deleteId === e.id && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void send({
                        action: "delete",
                        id: e.id,
                        revision: e.revision,
                      })
                    }
                  >
                    削除を確定
                  </button>
                )}
              </article>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(
                editing
                  ? {
                      action:
                        editing.status === "candidate" ? "accept" : "edit",
                      id: editing.id,
                      revision: editing.revision,
                      draft,
                    }
                  : { action: "add", draft },
              );
            }}
          >
            <h3>
              {editing
                ? "内容と出典を確認して保存"
                : "手動で候補を追加（追加通信なし）"}
            </h3>
            <label>
              種類{" "}
              <select
                aria-label="メモリの種類"
                value={draft.kind}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    kind: e.target.value as MemoryDraft["kind"],
                  })
                }
              >
                {MEMORY_KINDS.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <label>
              話題{" "}
              <input
                aria-label="メモリの話題"
                maxLength={100}
                required
                value={draft.topic}
                onChange={(e) => setDraft({ ...draft, topic: e.target.value })}
              />
            </label>
            <label>
              内容{" "}
              <textarea
                aria-label="メモリの内容"
                maxLength={2000}
                required
                value={draft.content}
                onChange={(e) =>
                  setDraft({ ...draft, content: e.target.value })
                }
              />
            </label>
            <label>
              期限（UTC・空欄はなし）{" "}
              <input
                aria-label="メモリの期限"
                type="datetime-local"
                value={
                  draft.expiresAt === undefined
                    ? ""
                    : new Date(draft.expiresAt).toISOString().slice(0, 16)
                }
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    expiresAt: e.target.value
                      ? Date.parse(`${e.target.value}Z`)
                      : undefined,
                  })
                }
              />
            </label>
            <button
              disabled={busy || !!editing?.sourceUnavailable}
              type="submit"
            >
              {editing
                ? editing.status === "candidate"
                  ? "編集内容で採用"
                  : "編集内容を保存"
                : "候補を追加"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(undefined);
                setDraft(empty());
              }}
            >
              新しい手動候補
            </button>
            {editing?.status === "candidate" && (
              <>
                <label>
                  統合先（採用済み）
                  <select
                    aria-label="メモリの統合先"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    <option value="">選択してください</option>
                    {list?.entries
                      .filter(
                        (e) => e.status === "accepted" && e.id !== editing.id,
                      )
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.topic}: {e.content.slice(0, 100)}
                        </option>
                      ))}
                  </select>
                </label>
                <p>
                  統合は上の編集内容で統合先本文を置き換えます。先に統合先を確認してください。既存の出典は残します。
                </p>
                <button
                  type="button"
                  disabled={busy || !target || editing.sourceUnavailable}
                  onClick={() =>
                    void send({
                      action: "merge",
                      id: editing.id,
                      revision: editing.revision,
                      draft,
                      target,
                      targetRevision: list?.entries.find((e) => e.id === target)
                        ?.revision,
                    })
                  }
                >
                  編集内容で統合を確定
                </button>
              </>
            )}
          </form>
        </section>
      )}
    </div>
  );
}
