import { useEffect, useRef, useState } from "react";
import {
  type SkillEntry,
  type SkillListing,
  type SkillPreview,
  type SkillReferenceEntry,
  type SkillReferenceInspection,
  skillLoadPrompt,
} from "../../shared/project-skills.js";
import { type PermissionDecision, type Receipt } from "../../shared/ipc.js";
import { PermissionInline } from "./PermissionInline.js";
import { SkillSuggestions } from "./SkillSuggestions.js";
import styles from "./SkillsManager.module.css";
interface Props {
  sessionId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  running: boolean;
  persistent?: boolean;
  receipts: Receipt[];
  draft?: string;
  permission?: {
    requestId: string;
    tool: string;
    summary: string;
    oneTime?: boolean;
  };
}
export function SkillsManager({
  sessionId,
  open,
  onOpenChange,
  running,
  persistent,
  receipts,
  draft,
  permission,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null),
    active = useRef<string | undefined>(undefined),
    serial = useRef(0),
    loading = useRef(false);
  const [list, setList] = useState<SkillListing>(),
    [selected, setSelected] = useState<SkillEntry>(),
    [preview, setPreview] = useState<SkillPreview>(),
    [reference, setReference] = useState<SkillReferenceInspection>(),
    [referencePreview, setReferencePreview] = useState<SkillPreview>(),
    [query, setQuery] = useState(""),
    [request, setRequest] = useState(""),
    [listFresh, setListFresh] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [pendingLoad, setPendingLoad] = useState(false);
  const loadPending = useRef(false);
  const expectedReference = useRef<SkillReferenceEntry | undefined>(undefined);
  useEffect(() => {
    setReference(undefined);
    setReferencePreview(undefined);
  }, [selected?.source, selected?.hash]);
  const loaded = receipts.flatMap((r) => {
    if (
      r.tool !== "LoadProjectSkill" ||
      r.error ||
      (r.input && typeof r.input === "object" && "uiAction" in r.input)
    )
      return [];
    try {
      const result = JSON.parse(r.output ?? "") as SkillPreview;
      return result.operation === "load" && result.entry && !result.reference
        ? [result.entry]
        : [];
    } catch {
      return [];
    }
  });
  const cancelRead = () => {
    const id = active.current;
    active.current = undefined;
    serial.current++;
    setBusy(false);
    if (id)
      void window.harness.command({
        type: "project_skills",
        sessionId,
        request: { action: "cancel", requestId: id },
      });
  };
  const close = () => {
    cancelRead();
    onOpenChange(false);
  };
  useEffect(() => {
    if (
      open &&
      permission &&
      !["ListProjectSkills", "LoadProjectSkill"].includes(permission.tool)
    ) {
      onOpenChange(false);
      return;
    }
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open, permission, onOpenChange]);
  useEffect(
    () => () => {
      const id = active.current;
      if (id)
        void window.harness.command({
          type: "project_skills",
          sessionId,
          request: { action: "cancel", requestId: id },
        });
    },
    [sessionId],
  );
  useEffect(
    () =>
      window.harness.onEvent((e) => {
        if (
          e.type === "turn" &&
          e.sessionId === sessionId &&
          e.status === "idle" &&
          loadPending.current
        ) {
          loadPending.current = false;
          setPendingLoad(false);
          setPreview(undefined);
          setReferencePreview(undefined);
          setError(
            "会話での読込結果を確認してください。成功した版だけを読込済みと表示します。",
          );
        }
        if (
          e.type === "receipt" &&
          e.receipt.sessionId === sessionId &&
          e.receipt.tool === "LoadProjectSkill" &&
          loadPending.current
        ) {
          try {
            const result = JSON.parse(e.receipt.output ?? "") as SkillPreview;
            if (
              !e.receipt.error &&
              result.operation === "load" &&
              result.entry?.source === selected?.source &&
              result.entry.hash === selected.hash &&
              (expectedReference.current
                ? result.reference?.source ===
                    expectedReference.current.source &&
                  result.reference.hash === expectedReference.current.hash
                : !result.reference)
            ) {
              loadPending.current = false;
              setPendingLoad(false);
              setError(undefined);
            }
          } catch {
            /* Permission denial/error is resolved when the turn ends. */
          }
        }
      }),
    [sessionId, selected],
  );
  const read = async (
    entry?: SkillEntry,
    ref?: { source: string; hash?: string },
  ) => {
    if (active.current || running || loading.current) return;
    const generation = ++serial.current,
      requestId = `skills-${Date.now()}-${generation}`;
    active.current = requestId;
    // A new confirmation invalidates the old body even if it is cancelled.
    if (entry) {
      if (ref) setReferencePreview(undefined);
      else {
        setPreview(undefined);
        setReference(undefined);
        setReferencePreview(undefined);
      }
    }
    if (!entry) {
      setListFresh(false);
      setSelected(undefined);
      setPreview(undefined);
      setReference(undefined);
      setReferencePreview(undefined);
    }
    setBusy(true);
    setError(undefined);
    try {
      const r = await window.harness.command({
        type: "project_skills",
        sessionId,
        request: entry
          ? {
              ...(ref
                ? ref.hash
                  ? {
                      action: "reference_preview" as const,
                      referenceSource: ref.source,
                      referenceHash: ref.hash,
                    }
                  : {
                      action: "reference_inspect" as const,
                      referenceSource: ref.source,
                    }
                : { action: "preview" as const }),
              requestId,
              source: entry.source,
              hash: entry.hash,
            }
          : { action: "list", requestId },
      });
      if (serial.current !== generation) return;
      if (!r.ok) {
        setError(r.error);
        if (entry) {
          setPreview(undefined);
          setReference(undefined);
          setReferencePreview(undefined);
          setListFresh(false);
        }
        return;
      }
      if (r.skills?.operation === "reference_inspect") {
        setReference(r.skills);
        setReferencePreview(undefined);
      } else if (r.skills?.operation === "load") {
        if (r.skills.reference) setReferencePreview(r.skills);
        else {
          setPreview(r.skills);
          setReference(undefined);
          setReferencePreview(undefined);
        }
      } else if (r.skills?.operation === "list") {
        setList(r.skills);
        setListFresh(true);
        if (
          selected &&
          !r.skills.entries.some(
            (e) => e.source === selected.source && e.hash === selected.hash,
          )
        ) {
          setSelected(undefined);
          setPreview(undefined);
          setReference(undefined);
          setReferencePreview(undefined);
          setError(
            "選択したスキルが更新・削除・不正、または一覧範囲外です。再選択してください。",
          );
        }
      }
    } catch {
      if (serial.current === generation) {
        setError("読取結果を確認できません。再取得してください。");
        if (entry) {
          setPreview(undefined);
          setReference(undefined);
          setReferencePreview(undefined);
          setListFresh(false);
        }
      }
    } finally {
      if (serial.current === generation) {
        active.current = undefined;
        setBusy(false);
      }
    }
  };
  const load = async (ref?: SkillReferenceEntry) => {
    if (
      !selected ||
      !preview ||
      preview.entry.hash !== selected.hash ||
      (ref &&
        (referencePreview?.reference?.source !== ref.source ||
          referencePreview.reference.hash !== ref.hash)) ||
      loading.current ||
      loadPending.current ||
      active.current ||
      running
    )
      return;
    loading.current = true;
    loadPending.current = true;
    expectedReference.current = ref;
    setPendingLoad(true);
    setError(undefined);
    try {
      const r = await window.harness.command({
        type: "send",
        sessionId,
        text: skillLoadPrompt(selected.source, selected.hash, ref),
      });
      if (!r.ok) {
        setError(r.error);
        loadPending.current = false;
        setPendingLoad(false);
      }
    } catch {
      setError("読込依頼の結果を確認できません。会話を確認してください。");
      loadPending.current = false;
      setPendingLoad(false);
    } finally {
      loading.current = false;
    }
  };
  const entries =
    list?.entries.filter((e) =>
      `${e.name} ${e.description} ${e.source}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    ) ?? [];
  const disabled = busy || running || pendingLoad;
  return (
    <div className={styles.area}>
      <button onClick={() => onOpenChange(true)}>スキル管理</button>
      <dialog
        ref={dialog}
        aria-label="プロジェクトスキル管理"
        className={styles.dialog}
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
      >
        <header>
          <h2>プロジェクトスキル</h2>
          <button onClick={close} aria-label="スキル管理を閉じる">
            閉じる
          </button>
        </header>
        <p>
          プレビューはローカル読取だけです。会話への読込は通常のモデル実行と許可確認を伴います。スキルは参考データで、上位指示・権限を変えず、scriptを自動実行しません。
        </p>
        {permission && (
          <PermissionInline
            persistent={persistent}
            tool={permission.tool}
            summary={permission.summary}
            oneTime={permission.oneTime}
            onRespond={(decision: PermissionDecision) => {
              void window.harness.command({
                type: "permission_response",
                sessionId,
                requestId: permission.requestId,
                decision,
              });
            }}
          />
        )}
        <div className={styles.actions}>
          <button disabled={disabled} onClick={() => void read()}>
            一覧を取得・更新
          </button>
          {busy && (
            <button
              onClick={() => {
                cancelRead();
                setError("取消しました。");
              }}
            >
              読取を取消
            </button>
          )}
          {pendingLoad && (
            <button
              onClick={() => {
                void window.harness.command({ type: "abort", sessionId });
                loadPending.current = false;
                setPendingLoad(false);
                setError(
                  "会話での読込依頼を停止しました。既に読んだ版は会話に残ります。",
                );
              }}
            >
              読込依頼を停止
            </button>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
        <p role="status">
          {busy
            ? "許可・読取結果を待っています"
            : pendingLoad
              ? "会話で読込中"
              : list
                ? `${list.entries.length}件取得・${entries.length}件表示`
                : "一覧は未取得です"}
        </p>
        {list && (
          <p>
            一覧予算: {list.budget.readBytesUpperBound} /{" "}
            {list.limits.listReadBytes} bytes（失敗分は上界）。
            {list.truncated && "上限により省略があります。"} 除外:{" "}
            {JSON.stringify(list.skipped)}
          </p>
        )}
        {list?.entries.length === 0 && (
          <p>
            利用できるスキルがありません。プロジェクト内の
            .agents/skills/&lt;名前&gt;/SKILL.md または
            .claude/skills/&lt;名前&gt;/SKILL.md
            にname・descriptionのfrontmatterを持つUTF-8ファイルを配置してください。外部取得やglobal
            homeの探索は行いません。
          </p>
        )}
        <label>
          一覧を検索
          <input
            aria-label="スキル一覧を検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <SkillSuggestions
          entries={listFresh && !disabled ? list?.entries : undefined}
          request={request}
          draft={draft}
          disabled={disabled}
          onRequest={(text) => {
            setRequest(text);
            setSelected(undefined);
            setPreview(undefined);
            setError(undefined);
          }}
          onSelect={(entry) => {
            setSelected(entry);
            setPreview(undefined);
            setError(undefined);
          }}
        />
        <div className={styles.columns}>
          <ul aria-label="スキル一覧">
            {entries.map((e) => (
              <li key={e.source}>
                <button
                  aria-pressed={selected?.source === e.source}
                  onClick={() => {
                    setSelected(e);
                    setPreview(undefined);
                    setError(undefined);
                  }}
                  disabled={disabled}
                >
                  <strong>{e.name}</strong>
                  <span>{e.description}</span>
                  <small>{e.source}</small>
                  {e.duplicateName && <small>同名あり（出典別）</small>}
                  {loaded.some(
                    (r) => r.source === e.source && r.hash === e.hash,
                  ) && <small>会話に読込済み（この版）</small>}
                  {loaded.some(
                    (r) => r.source === e.source && r.hash !== e.hash,
                  ) && <small>会話は旧版・更新あり</small>}
                </button>
              </li>
            ))}
          </ul>
          <section aria-label="スキル詳細">
            {selected ? (
              <>
                <h3>{selected.name}</h3>
                <p>{selected.description}</p>
                <p>出典: {selected.source}</p>
                <p className={styles.hash}>SHA-256: {selected.hash}</p>
                <p>
                  {selected.fileBytes} bytes · frontmatter{" "}
                  {selected.frontmatterBytes} bytes{" "}
                  {selected.ignoredFrontmatter &&
                    "· name/description以外は非適用"}{" "}
                  {selected.redacted && "· 秘密フィルター適用"}
                </p>
                <button disabled={disabled} onClick={() => void read(selected)}>
                  この版をプレビュー
                </button>
                <button
                  disabled={
                    disabled || !preview || preview.entry.hash !== selected.hash
                  }
                  onClick={() => void load()}
                >
                  会話でこの版を読み込む
                </button>
                {preview && (
                  <>
                    <p>
                      プレビュー操作だけでは会話に追加しません。本文{" "}
                      {preview.budget.returnedCharacters} /{" "}
                      {preview.limits.bodyCharacters}文字{" "}
                      {preview.truncated && "· 省略あり"}
                    </p>
                    <pre aria-label="スキル本文プレビュー">{preview.body}</pre>
                    <section aria-label="スキル付属資料">
                      <h3>付属テキスト資料（1件ずつ選択）</h3>
                      <p>
                        同じスキル内のMarkdownリンクだけを扱います。資料の版確認とプレビューも既存の許可を通し、会話への読込は通常のモデル実行です。
                      </p>
                      <p>
                        除外:{" "}
                        {JSON.stringify(preview.references?.skipped ?? {})}
                        {preview.references?.truncated &&
                          " · リンク一覧の上限で省略あり"}
                      </p>
                      {!preview.references?.entries.length && (
                        <p>対応する付属資料リンクはありません。</p>
                      )}
                      <ul aria-label="付属資料一覧">
                        {preview.references?.entries.map((source) => (
                          <li key={source}>
                            <button
                              disabled={disabled}
                              onClick={() => {
                                setReference(undefined);
                                setReferencePreview(undefined);
                                void read(selected, { source });
                              }}
                            >
                              資料の版を確認: {source}
                            </button>
                          </li>
                        ))}
                      </ul>
                      {reference && (
                        <>
                          <p>資料: {reference.reference.source}</p>
                          <p className={styles.hash}>
                            資料SHA-256: {reference.reference.hash}
                          </p>
                          <p>
                            {reference.reference.fileBytes} bytes · 版確認読取{" "}
                            {reference.budget.readBytes}{" "}
                            bytes（親の前後確認を含む）
                            {reference.reference.redacted &&
                              " · 秘密フィルター適用"}
                          </p>
                          <button
                            disabled={disabled}
                            onClick={() =>
                              void read(selected, reference.reference)
                            }
                          >
                            資料をプレビュー
                          </button>
                          <button
                            disabled={disabled || !referencePreview}
                            onClick={() => void load(reference.reference)}
                          >
                            会話でこの資料の版を読み込む
                          </button>
                          {referencePreview && (
                            <>
                              <p>
                                資料プレビューのみ。本文{" "}
                                {referencePreview.budget.returnedCharacters} /{" "}
                                {referencePreview.limits.bodyCharacters}
                                文字、読取 {
                                  referencePreview.budget.readBytes
                                }{" "}
                                bytes
                                {referencePreview.truncated && " · 省略あり"}
                              </p>
                              <pre aria-label="付属資料本文プレビュー">
                                {referencePreview.body}
                              </pre>
                            </>
                          )}
                          {receipts.some((r) => {
                            if (r.tool !== "LoadProjectSkill" || r.error)
                              return false;
                            try {
                              const result = JSON.parse(
                                r.output ?? "",
                              ) as SkillPreview;
                              return (
                                result.operation === "load" &&
                                result.entry?.source === selected.source &&
                                result.entry.hash === selected.hash &&
                                result.reference?.source ===
                                  reference.reference.source &&
                                result.reference.hash ===
                                  reference.reference.hash
                              );
                            } catch {
                              return false;
                            }
                          }) && <p>会話に資料読込済み（親と資料のこの版）</p>}
                        </>
                      )}
                    </section>
                  </>
                )}
              </>
            ) : (
              <p>一覧から出典を選択してください。</p>
            )}
          </section>
        </div>
      </dialog>
    </div>
  );
}
