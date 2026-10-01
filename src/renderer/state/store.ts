import { create } from "zustand";
import { summarizeInput } from "../../shared/summary.js";
import {
  type AppState,
  type StepNode,
  type StepNumber,
  type TranscriptItem,
  type UiEvent,
} from "../../shared/ipc.js";

export interface PendingPermission {
  requestId: string;
  receiptId?: string;
  tool: string;
  summary: string;
}
export interface SessionView {
  items: TranscriptItem[];
  running: boolean;
  step?: { step: StepNumber; node: StepNode; round: number };
  pending?: PendingPermission;
}
export interface EventState {
  app: AppState | null;
  views: Record<string, SessionView>;
}

const empty = (): SessionView => ({ items: [], running: false });
const view = (s: EventState, id: string) => s.views[id] ?? empty();
const put = (s: EventState, id: string, v: SessionView): EventState => ({
  ...s,
  views: { ...s.views, [id]: v },
});
const withItem = (v: SessionView, item: TranscriptItem): SessionView => ({
  ...v,
  items: [...v.items, item],
});
let noticeSeq = 0;
export const notice = (
  tone: "dim" | "warn" | "err",
  text: string,
): TranscriptItem => ({ kind: "notice", id: `n${++noticeSeq}`, tone, text });

/** main から届くイベントを反映するだけの純関数(レンダラは状態を持たない: §16.4) */
export function applyEvent(s: EventState, e: UiEvent): EventState {
  switch (e.type) {
    case "state":
      return { ...s, app: e.state };
    case "transcript":
      return put(s, e.sessionId, { ...view(s, e.sessionId), items: e.items });
    case "turn": {
      const v = view(s, e.sessionId);
      const next: SessionView = {
        ...v,
        running: e.status === "running",
        step: e.status === "running" ? v.step : undefined,
        pending: e.status === "running" ? v.pending : undefined,
      };
      return put(
        s,
        e.sessionId,
        e.status === "idle" && e.stopCause === "aborted"
          ? withItem(next, notice("dim", "中断しました"))
          : next,
      );
    }
    case "step":
      return put(s, e.sessionId, {
        ...view(s, e.sessionId),
        step: { step: e.step, node: e.node, round: e.round },
      });
    case "text_delta": {
      const v = view(s, e.sessionId);
      const last = v.items.at(-1);
      if (last?.kind === "assistant" && last.id === e.messageId)
        return put(s, e.sessionId, {
          ...v,
          items: [
            ...v.items.slice(0, -1),
            { ...last, text: last.text + e.text },
          ],
        });
      return put(
        s,
        e.sessionId,
        withItem(v, { kind: "assistant", id: e.messageId, text: e.text }),
      );
    }
    case "tool_call":
      return put(
        s,
        e.sessionId,
        withItem(view(s, e.sessionId), {
          kind: "tool",
          id: e.receiptId,
          tool: e.tool,
          summary: summarizeInput(e.tool, e.input),
          status: "pending",
        }),
      );
    case "tool_result": {
      const v = view(s, e.sessionId);
      return put(s, e.sessionId, {
        ...v,
        items: v.items.map((i) =>
          i.kind === "tool" && i.id === e.receiptId && i.status !== "denied"
            ? { ...i, status: e.isError ? "error" : "ok" }
            : i,
        ),
      });
    }
    case "permission_request":
      return put(s, e.sessionId, {
        ...view(s, e.sessionId),
        pending: {
          requestId: e.requestId,
          receiptId: e.receiptId,
          tool: e.tool,
          summary: e.summary,
        },
      });
    case "permission_resolved": {
      const v = view(s, e.sessionId);
      const receiptId = v.pending?.receiptId;
      return put(s, e.sessionId, {
        ...v,
        pending: undefined,
        items:
          e.decision === "deny" && receiptId
            ? v.items.map((i) =>
                i.kind === "tool" && i.id === receiptId
                  ? { ...i, status: "denied" }
                  : i,
              )
            : v.items,
      });
    }
    case "error": {
      const id = e.sessionId ?? s.app?.currentSessionId;
      return id
        ? put(s, id, withItem(view(s, id), notice("err", e.message)))
        : s;
    }
    // Phase 2 では表示しない(Receipts / UsagePopover / AgentsPanel は Phase 4-5)
    case "receipt":
    case "usage":
    case "agent":
      return s;
  }
}

export interface Prefs {
  sidebarOpen: boolean;
  collapsed: Record<string, boolean>;
  sort: "recent" | "name";
  search: string;
  pickerOpen: boolean;
}
const PREFS_KEY = "xharness.prefs";
function loadPrefs(): Prefs {
  const base: Prefs = {
    sidebarOpen: true,
    collapsed: {},
    sort: "recent",
    search: "",
    pickerOpen: false,
  };
  try {
    const saved = JSON.parse(
      localStorage.getItem(PREFS_KEY) ?? "{}",
    ) as Partial<Prefs>;
    return {
      ...base,
      sidebarOpen: saved.sidebarOpen ?? base.sidebarOpen,
      collapsed: saved.collapsed ?? base.collapsed,
      sort: saved.sort === "name" ? "name" : "recent",
    };
  } catch {
    return base;
  }
}
function savePrefs(p: Prefs) {
  try {
    // 画面の開閉状態だけを保存する(トークンや会話は入れない)
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        sidebarOpen: p.sidebarOpen,
        collapsed: p.collapsed,
        sort: p.sort,
      }),
    );
  } catch {
    /* 保存できなくても動作は続ける */
  }
}

interface UiStore extends EventState {
  prefs: Prefs;
  apply(event: UiEvent): void;
  setPrefs(patch: Partial<Prefs>): void;
  toggleGroup(id: string): void;
  start(): () => void;
  send(text: string): Promise<void>;
  abort(): void;
  respond(decision: "allow" | "always" | "deny"): void;
  newSession(workspaceId: string | null, readOnly?: boolean): Promise<void>;
  openSession(id: string): void;
  closeSession(id: string): void;
  pickFolder(): Promise<string | undefined>;
}

export const useStore = create<UiStore>()((set, get) => ({
  app: null,
  views: {},
  prefs: loadPrefs(),
  apply: (event) => set((s) => applyEvent(s, event)),
  setPrefs: (patch) =>
    set((s) => {
      const prefs = { ...s.prefs, ...patch };
      savePrefs(prefs);
      return { prefs };
    }),
  toggleGroup: (id) =>
    get().setPrefs({
      collapsed: {
        ...get().prefs.collapsed,
        [id]: !get().prefs.collapsed[id],
      },
    }),
  start() {
    const off = window.harness.onEvent((event) => get().apply(event));
    void window.harness.command({ type: "ready" });
    return off;
  },
  async send(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    let id = get().app?.currentSessionId ?? null;
    if (!id) {
      const created = await window.harness.command({
        type: "new_session",
        workspaceId: null,
      });
      if (!created.ok || !created.sessionId) return;
      id = created.sessionId;
    }
    const sessionId = id;
    set((s) =>
      put(
        s,
        sessionId,
        withItem(view(s, sessionId), {
          kind: "user",
          id: `u${Date.now()}`,
          text: trimmed,
        }),
      ),
    );
    const result = await window.harness.command({
      type: "send",
      sessionId,
      text: trimmed,
    });
    if (!result.ok)
      get().apply({ type: "error", sessionId, message: result.error });
  },
  abort() {
    const id = get().app?.currentSessionId;
    if (id) void window.harness.command({ type: "abort", sessionId: id });
  },
  respond(decision) {
    const id = get().app?.currentSessionId;
    const pending = id ? get().views[id]?.pending : undefined;
    if (id && pending)
      void window.harness.command({
        type: "permission_response",
        sessionId: id,
        requestId: pending.requestId,
        decision,
      });
  },
  async newSession(workspaceId, readOnly) {
    await window.harness.command({
      type: "new_session",
      workspaceId,
      readOnly,
    });
  },
  openSession(id) {
    void window.harness.command({ type: "open_session", sessionId: id });
  },
  closeSession(id) {
    void window.harness.command({ type: "close_session", sessionId: id });
  },
  async pickFolder() {
    const r = await window.harness.command({ type: "pick_folder" });
    return r.ok ? r.workspaceId : undefined;
  },
}));
