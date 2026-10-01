import {
  type AppState,
  type SessionSummary,
  type WorkspaceSummary,
} from "../../shared/ipc.js";

export interface SessionGroup {
  /** workspaceId。ワークスペース指定なしは "other"(§18.5) */
  id: string;
  name: string;
  path?: string;
  kind?: WorkspaceSummary["kind"];
  sessions: SessionSummary[];
  running: boolean;
  ask: boolean;
  isOther: boolean;
}

/** §16.6: ワークスペースごとにグループ化し、末尾に「その他」。 */
export function groupSessions(
  app: Pick<AppState, "sessions" | "workspaces">,
  opts: { search: string; sort: "recent" | "name" },
): SessionGroup[] {
  const q = opts.search.trim().toLowerCase();
  const match = (s: SessionSummary) => !q || s.title.toLowerCase().includes(q);
  const byUpdated = (a: SessionSummary, b: SessionSummary) =>
    b.updatedAt - a.updatedAt;
  const make = (
    id: string,
    name: string,
    all: SessionSummary[],
    extra: Partial<SessionGroup>,
  ): SessionGroup | undefined => {
    const sessions = all.filter(match).sort(byUpdated);
    // 検索中は一致のないグループを隠す。通常時は空のワークスペースも出す
    if (q && !sessions.length) return undefined;
    return {
      id,
      name,
      sessions,
      running: sessions.some((s) => s.status !== "idle"),
      ask: sessions.some((s) => s.status === "ask"),
      isOther: false,
      ...extra,
    };
  };
  const groups: SessionGroup[] = [];
  const last = new Map<string, number>();
  for (const w of app.workspaces) {
    const own = app.sessions.filter((s) => s.workspaceId === w.id);
    const g = make(w.id, w.name, own, { path: w.root, kind: w.kind });
    if (!g) continue;
    groups.push(g);
    last.set(w.id, Math.max(w.lastOpenedAt, ...own.map((s) => s.updatedAt)));
  }
  groups.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1; // 実行中は常に上
    return opts.sort === "name"
      ? a.name.localeCompare(b.name)
      : (last.get(b.id) ?? 0) - (last.get(a.id) ?? 0);
  });
  const known = new Set(app.workspaces.map((w) => w.id));
  // 一覧から外したワークスペースのセッションも消さず「その他」に出す
  const other = make(
    "other",
    "その他",
    app.sessions.filter((s) => !s.workspaceId || !known.has(s.workspaceId)),
    { isOther: true, path: "ワークスペース指定なし" },
  );
  if (other && (other.sessions.length || !q)) groups.push(other);
  return groups.filter((g) => !g.isOther || g.sessions.length);
}

export function ago(ts: number, now = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
