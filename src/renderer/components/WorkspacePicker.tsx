import { useEffect, useState } from "react";
import { type WorkspaceSummary } from "../../shared/ipc.js";
import styles from "./WorkspacePicker.module.css";

export interface WorkspacePickerProps {
  workspaces: WorkspaceSummary[];
  /** 現在のセッションのワークスペース */
  currentId: string | null;
  onPickFolder(): Promise<string | undefined>;
  onStart(workspaceId: string | null, readOnly: boolean): void;
  onForget(workspaceId: string): void;
  onClose(): void;
}

/** §18.2 folder タブ。repository タブは Phase 4 */
export function WorkspacePicker(p: WorkspacePickerProps) {
  const [selected, setSelected] = useState<string | null>(p.currentId);
  const [readOnly, setReadOnly] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") p.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);
  const open = async () => {
    const id = await p.onPickFolder();
    if (id) setSelected(id);
  };
  const current = p.workspaces.find((w) => w.id === selected);
  return (
    <div className={styles.pop} role="dialog" aria-label="workspace">
      <div className={styles.seg} role="tablist">
        <button type="button" role="tab" aria-selected className={styles.on}>
          folder
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={false}
          disabled
          title="repository タブは Phase 4 で対応"
        >
          repository
        </button>
      </div>
      <div className={styles.sec}>
        <div className={styles.lbl}>recent</div>
        {p.workspaces.map((w) => (
          <div
            key={w.id}
            className={`${styles.recent} ${w.id === selected ? styles.cur : ""}`}
          >
            <button
              type="button"
              className={styles.rowBtn}
              onClick={() => setSelected(w.id)}
              aria-pressed={w.id === selected}
              title={w.root}
            >
              <span
                style={{
                  color: w.id === selected ? "var(--claude)" : "var(--dim)",
                }}
              >
                {w.id === selected ? "●" : "○"}
              </span>
              <span className={styles.root}>{w.root}</span>
              <span className={styles.meta}>
                {w.kind}
                {w.branch ? ` · ${w.branch}` : ""}
              </span>
            </button>
            <button
              type="button"
              className={styles.forget}
              aria-label={`${w.name} を一覧から外す`}
              title="一覧から外す(セッションは消えません)"
              onClick={() => {
                p.onForget(w.id);
                if (selected === w.id) setSelected(null);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <div
          className={`${styles.recent} ${selected === null ? styles.cur : ""}`}
        >
          <button
            type="button"
            className={styles.rowBtn}
            onClick={() => setSelected(null)}
            aria-pressed={selected === null}
          >
            <span
              style={{
                color: selected === null ? "var(--claude)" : "var(--dim)",
              }}
            >
              {selected === null ? "●" : "○"}
            </span>
            <span className={styles.root}>ワークスペースなし</span>
            <span className={styles.meta}>その他</span>
          </button>
        </div>
      </div>
      <div className={styles.sec}>
        <div className={styles.lbl}>session</div>
        <label className={`${styles.opt} ${styles.disabled}`}>
          <input type="checkbox" disabled /> worktree で隔離する
          <span className={styles.sub}>
            Phase 4 で対応(git 管理下のときだけ有効)
          </span>
        </label>
        <label className={styles.opt}>
          <input
            type="checkbox"
            checked={readOnly}
            disabled={selected === null}
            onChange={(e) => setReadOnly(e.target.checked)}
          />{" "}
          読み取り専用で開く
          <span className={styles.sub}>
            書き込み系ツールを渡さない(plan 相当)
          </span>
        </label>
      </div>
      <div className={`${styles.sec} ${styles.actions}`}>
        <button type="button" className={styles.btn} onClick={open}>
          open folder…<kbd>Ctrl+O</kbd>
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.primary}`}
          onClick={() => {
            p.onStart(selected, readOnly && selected !== null);
            p.onClose();
          }}
        >
          start session{current ? ` in ${current.name}` : ""}
        </button>
      </div>
    </div>
  );
}
