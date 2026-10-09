import { useEffect, useRef, useState } from "react";
import type {
  OfficialSkillAction,
  OfficialSkillSelection,
  OfficialSkillsView,
} from "../../shared/official-skills.js";
import styles from "./SkillsManager.module.css";

export function OfficialSkillsManager({
  sessionId,
  provider,
  running,
}: {
  sessionId: string;
  provider: "claude" | "codex";
  running: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    generation = useRef(0);
  const [open, setOpen] = useState(false),
    [target, setTarget] = useState(provider);
  const [view, setView] = useState<OfficialSkillsView>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    generation.current++;
    setTarget(provider);
    setView(undefined);
    setBusy(false);
    setError("");
  }, [sessionId, provider]);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current?.close();
    return () => {
      generation.current++;
    };
  }, [open, sessionId]);
  const request = async (action: OfficialSkillAction) => {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await window.harness.command({
        type: "official_skills",
        sessionId,
        request: action,
      });
      if (current !== generation.current) return;
      if (!result.ok || !result.officialSkills)
        throw new Error(
          result.ok ? "公式スキルの保存状態を取得できません" : result.error,
        );
      const fresh = result.officialSkills;
      setView((old) => ({
        catalog: fresh.catalog ?? old?.catalog,
        preview: fresh.preview ?? old?.preview,
        selected: fresh.selected,
      }));
    } catch (e) {
      if (current === generation.current)
        setError(
          e instanceof Error ? e.message : "公式スキルの操作に失敗しました",
        );
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (open) void request({ action: "list", provider: target });
    return () => {
      generation.current++;
    };
  }, [open, target, sessionId, provider]);
  const close = () => {
    generation.current++;
    setOpen(false);
    setBusy(false);
  };
  const preview = view?.preview;
  const select = () => {
    if (!preview?.entry.eligible) return;
    const { provider, scope, name, source, hash, bundleHash } = preview.entry;
    const selection: OfficialSkillSelection = {
      provider,
      scope,
      name,
      source,
      hash,
      bundleHash,
    };
    void request({ action: "select", selection });
  };
  return (
    <div className={styles.area}>
      <button onClick={() => setOpen(true)}>公式スキル</button>
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-label="公式スキルの選択"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <header>
          <h2>公式スキルの選択</h2>
          <button onClick={close}>閉じる</button>
        </header>
        <p>
          公式実行基盤のスキル機構へ渡す候補を選択します。4000文字の参考資料送信とは別の操作です。参考資料へ自動で置き換えません。
        </p>
        <p>
          公式機構への対応は、提供元の公式作成・監修や安全性の認定を意味しません。選択・送信済みの記録と、実際の使用・完了を区別します。
        </p>
        <p role="status">
          {target === "codex"
            ? "Codex：一覧・本文プレビュー・選択の保存に対応。未選択スキルの隔離を確認できないため、選択スキルを伴う実行は停止します。"
            : "Claude：通常のnative作業で選択スキルをplugin経由で渡します。質問・固定課題での実行は未対応のため停止します。"}
        </p>
        <label>
          実行基盤{" "}
          <select
            aria-label="公式スキルの実行基盤"
            value={target}
            disabled={busy || running}
            onChange={(event) => {
              generation.current++;
              setView(undefined);
              setTarget(event.target.value as typeof target);
            }}
          >
            <option value="claude">Claude · plugin</option>
            <option value="codex">Codex · skill input</option>
          </select>
        </label>
        <button
          disabled={busy || running}
          onClick={() => void request({ action: "list", provider: target })}
        >
          一覧を更新
        </button>
        {busy && <p role="status">公式スキルの保存状態を確認中</p>}
        {error && <p role="alert">{error}</p>}
        <section aria-label="選択済みの公式スキル">
          <h3>選択済み</h3>
          <p>
            次の呼出へ渡す候補です。実際に使用・完了した証明ではありません。
          </p>
          {view?.selected.length ? (
            <ul>
              {view.selected.map((pin) => (
                <li key={`${pin.provider}:${pin.source}`}>
                  {pin.provider} · {pin.scope} · {pin.name}
                  <p>{pin.source}</p>
                  <p>
                    本文hash：{pin.hash} / bundle hash：{pin.bundleHash}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p>選択なし</p>
          )}
          <button
            disabled={busy || running || !view?.selected.length}
            onClick={() => void request({ action: "clear" })}
          >
            選択をすべて解除
          </button>
        </section>
        <div className={styles.columns}>
          <section aria-label="公式スキル一覧">
            <h3>user / project</h3>
            {view?.catalog?.entries.length === 0 && (
              <p>この実行基盤で見つかったスキルはありません</p>
            )}
            <ul>
              {view?.catalog?.entries.map((entry) => (
                <li key={entry.source}>
                  <button
                    disabled={busy || running}
                    onClick={() =>
                      void request({
                        action: "preview",
                        provider: target,
                        source: entry.source,
                      })
                    }
                  >
                    {entry.name} · {entry.scope}
                  </button>
                  <small>{entry.description}</small>
                  <small>{entry.source}</small>
                  {!entry.eligible && (
                    <p>
                      選択できない理由：
                      {entry.reasons.join(" / ") || "現在の機構に未対応"}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section aria-label="公式スキル本文プレビュー">
            <h3>本文プレビュー</h3>
            {preview && (
              <>
                <strong>{preview.entry.name}</strong>
                <p>
                  {preview.entry.provider} · {preview.entry.scope} ·{" "}
                  {preview.entry.source}
                </p>
                <p>
                  本文hash：{preview.entry.hash} / bundle hash：
                  {preview.entry.bundleHash}
                </p>
                {!preview.entry.eligible && (
                  <p role="status">
                    選択できない理由：{preview.entry.reasons.join(" / ")}
                  </p>
                )}
                {preview.files?.map((file) => (
                  <div key={file.relativePath}>
                    <h4>{file.relativePath}</h4>
                    <small>{file.hash}</small>
                    <pre>{file.body}</pre>
                  </div>
                ))}
                <button
                  disabled={
                    busy ||
                    running ||
                    !preview.entry.eligible ||
                    !preview.files?.length
                  }
                  onClick={select}
                >
                  この公式スキルを選択
                </button>
              </>
            )}
          </section>
        </div>
      </dialog>
    </div>
  );
}
