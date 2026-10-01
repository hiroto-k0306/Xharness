import { useEffect, useState, useRef } from "react";
import { type WorkspaceSummary } from "../../shared/ipc.js";
import styles from "./WorkspacePicker.module.css";

export interface WorkspacePickerProps {
  gitAvailable?: boolean;
  fake?: boolean;
  progress?: string;
  workspaces: WorkspaceSummary[];
  /** 現在のセッションのワークスペース */
  currentId: string | null;
  onPickFolder(): Promise<string | undefined>;
  onStart(
    workspaceId: string | null,
    readOnly: boolean,
    isolated?: boolean,
    baseBranch?: string,
    newBranch?: string,
  ): void;
  onForget(workspaceId: string): void;
  onClose(): void;
}

/** §18.2 folder タブ。repository タブは Phase 4 */
export function WorkspacePicker(p: WorkspacePickerProps) {
  const [selected, setSelected] = useState<string | null>(p.currentId);
  const [readOnly, setReadOnly] = useState(false);
  const [tab, setTab] = useState<"folder" | "repository">("folder");
  const [isolated, setIsolated] = useState(false);
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [destination, setDestination] = useState("");
  const [shallow, setShallow] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  useEffect(
    () => () => {
      if (busyRef.current)
        void window.harness.command({ type: "abort_repository" });
    },
    [],
  );
  const [error, setError] = useState("");
  const clone = async () => {
    setBusy(true);
    busyRef.current = true;
    setError("");
    try {
      const result = await window.harness.command({
        type: "open_repository",
        url,
        branch: branch || undefined,
        destination: destination || undefined,
        shallow,
      });
      if (result.ok && result.workspaceId) {
        setSelected(result.workspaceId);
        setTab("folder");
      } else setError(result.ok ? "Repository unavailable" : result.error);
    } catch {
      setError("Git operation failed");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
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
        <button
          type="button"
          role="tab"
          aria-selected={tab === "folder"}
          className={tab === "folder" ? styles.on : ""}
          onClick={() => setTab("folder")}
        >
          folder
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "repository"}
          onClick={() => setTab("repository")}
          disabled={p.fake || p.gitAvailable === false}
          title={
            p.fake
              ? "--fake ではリポジトリ通信を行いません"
              : "リポジトリを clone / fetch"
          }
        >
          repository
        </button>
      </div>
      {tab === "repository" ? (
        <div className={styles.sec}>
          <label>
            URL
            <input
              aria-label="repository URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label>
            branch
            <input
              aria-label="repository branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
          </label>
          <label>
            clone destination
            <input
              aria-label="clone destination"
              placeholder="~/.xharness/repos/owner/repo"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={shallow}
              onChange={(e) => setShallow(e.target.checked)}
            />
            shallow clone
          </label>
          <button
            className={styles.btn}
            disabled={busy || !url.trim()}
            onClick={() => void clone()}
          >
            clone / fetch
          </button>
          {busy && (
            <>
              <span role="status">{p.progress ?? "Git…"}</span>
              <button
                onClick={() =>
                  void window.harness.command({ type: "abort_repository" })
                }
              >
                cancel
              </button>
            </>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      ) : (
        <>
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
            <label className={styles.opt}>
              <input
                type="checkbox"
                checked={isolated}
                disabled={
                  !current ||
                  current.kind === "no git" ||
                  p.gitAvailable === false
                }
                onChange={(e) => setIsolated(e.target.checked)}
              />{" "}
              worktree で隔離する
              <span className={styles.sub}>git 管理下のときだけ有効</span>
            </label>
            {isolated && current && current.kind !== "no git" && (
              <>
                <label>
                  base branch
                  <input
                    aria-label="worktree base branch"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                  />
                </label>
                <label>
                  new branch
                  <input
                    aria-label="new worktree branch"
                    value={newBranch}
                    placeholder="xh/session"
                    onChange={(e) => setNewBranch(e.target.value)}
                  />
                </label>
              </>
            )}
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
                if (isolated && current && current.kind !== "no git")
                  p.onStart(
                    selected,
                    readOnly && selected !== null,
                    true,
                    branch || undefined,
                    newBranch || undefined,
                  );
                else p.onStart(selected, readOnly && selected !== null);
                p.onClose();
              }}
            >
              start session{current ? ` in ${current.name}` : ""}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
