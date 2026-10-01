import { type SessionSummary } from "../../shared/ipc.js";
import { ago, groupSessions } from "../state/groups.js";
import { stepColor } from "../state/steps.js";
import { type SessionView } from "../state/store.js";
import styles from "./Sidebar.module.css";

export interface SidebarProps {
  app: {
    sessions: SessionSummary[];
    workspaces: Parameters<typeof groupSessions>[0]["workspaces"];
    currentSessionId: string | null;
    model: string;
    version: string;
  };
  views: Record<string, SessionView>;
  collapsed: Record<string, boolean>;
  sort: "recent" | "name";
  search: string;
  now?: number;
  onNew(): void;
  onOpen(id: string): void;
  onToggleGroup(id: string): void;
  onSearch(text: string): void;
  onSort(sort: "recent" | "name"): void;
}

const providerColor = { claude: "var(--claude)", codex: "var(--codex)" };

export function Sidebar(p: SidebarProps) {
  const groups = groupSessions(p.app, { search: p.search, sort: p.sort });
  const total = p.app.sessions.length;
  return (
    <aside className={styles.side} aria-label="sessions">
      <button type="button" className={styles.newBtn} onClick={p.onNew}>
        <span>+ new session</span>
        <kbd>Ctrl+N</kbd>
      </button>
      <input
        className={styles.search}
        type="search"
        placeholder="search sessions"
        aria-label="search sessions"
        value={p.search}
        onChange={(e) => p.onSearch(e.target.value)}
      />
      <div className={styles.filter}>
        <button
          type="button"
          onClick={() => p.onSort(p.sort === "recent" ? "name" : "recent")}
          title="並び順を切り替え"
        >
          sort: {p.sort} ▾
        </button>
        <span>
          {groups.filter((g) => !g.isOther).length} workspaces · {total}
        </span>
      </div>
      <div className={styles.list}>
        {groups.map((g) => {
          const closed = !!p.collapsed[g.id];
          return (
            <section
              key={g.id}
              className={`${styles.group} ${g.isOther ? styles.other : ""}`}
              data-testid={`group-${g.id}`}
            >
              <button
                type="button"
                className={styles.head}
                aria-expanded={!closed}
                onClick={() => p.onToggleGroup(g.id)}
              >
                <span
                  className={`${styles.fold} ${closed ? "" : styles.foldOpen}`}
                >
                  ▾
                </span>
                <span className={styles.name}>{g.name}</span>
                <span className={styles.count}>
                  {g.ask ? (
                    <span style={{ color: "var(--warn)" }}>● </span>
                  ) : g.running ? (
                    <span style={{ color: "var(--code)" }}>● </span>
                  ) : null}
                  {g.sessions.length}
                </span>
              </button>
              <div className={styles.path} title={g.path}>
                {g.path}
                {g.kind ? ` · ${g.kind}` : ""}
              </div>
              {!closed &&
                g.sessions.map((s) => {
                  const view = p.views[s.id];
                  const color = view?.step
                    ? stepColor(view.step.node, p.app.model)
                    : "var(--code)";
                  return (
                    <button
                      type="button"
                      key={s.id}
                      className={`${styles.sess} ${
                        s.id === p.app.currentSessionId ? styles.cur : ""
                      } ${s.status === "ask" ? styles.askRow : ""}`}
                      aria-current={s.id === p.app.currentSessionId}
                      onClick={() => p.onOpen(s.id)}
                    >
                      <div className={styles.title}>{s.title}</div>
                      <div className={styles.meta}>
                        {s.providers.map((pr) => (
                          <i
                            key={pr}
                            className={styles.pdot}
                            style={{ background: providerColor[pr] }}
                          />
                        ))}
                        {s.branch && <span>⎇ {s.branch}</span>}
                        {s.readOnly && <span>read-only</span>}
                        {s.status === "running" ? (
                          <span
                            className={styles.live}
                            style={{ ["--glow" as string]: color }}
                          >
                            ● running
                          </span>
                        ) : s.status === "ask" ? (
                          <span style={{ color: "var(--warn)" }}>● ask</span>
                        ) : (
                          <span>{ago(s.updatedAt, p.now)}</span>
                        )}
                      </div>
                    </button>
                  );
                })}
            </section>
          );
        })}
        {!groups.length && (
          <div className={styles.empty}>
            {p.search
              ? "# 一致するセッションはありません"
              : "# セッションはまだありません"}
          </div>
        )}
      </div>
      <div className={styles.foot}>
        <span>XHarness</span>
        <span>v{p.app.version}</span>
      </div>
    </aside>
  );
}
