import { create } from "zustand";
import { detailInput, summarizeInput } from "../../shared/summary.js";
import { parseTodos } from "../../shared/todos.js";
import { parseQuestionChoices } from "../../shared/questions.js";
import {
  REPORTED_ERRORS,
  type AppState,
  type StepNode,
  type StepNumber,
  type TranscriptItem,
  type UiEvent,
  type Receipt,
  type PermissionDecision,
} from "../../shared/ipc.js";

export interface PendingPermission {
  oneTime?: boolean;
  agentId?: string;
  plan?: unknown[];
  requestId: string;
  receiptId?: string;
  tool: string;
  summary: string;
}
export interface SessionView {
  rewind?: Extract<UiEvent, { type: "rewind_request" }>;
  agents?: Record<
    string,
    Extract<UiEvent, { type: "agent" }> & {
      text?: string;
      items?: TranscriptItem[];
    }
  >;
  activeAgent?: string;
  workflow?: Extract<UiEvent, { type: "workflow" }>;
  agentSteps?: Record<string, Extract<UiEvent, { type: "agent_step" }>>;
  stepCount?: number;
  receipts?: Receipt[];
  items: TranscriptItem[];
  running: boolean;
  step?: {
    step: StepNumber;
    node: StepNode;
    round: number;
    index?: number;
    total?: number;
  };
  pending?: PendingPermission;
  /** MCP の状態とプロンプト(/mcp の表示・入力欄の補完。§25.8) */
  mcp?: Omit<Extract<UiEvent, { type: "mcp" }>, "type" | "sessionId" | "show">;
}
export interface EventState {
  repositoryProgress?: string;
  usage?: Partial<
    Record<"claude" | "codex", Extract<UiEvent, { type: "usage" }>>
  >;
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
): Extract<TranscriptItem, { kind: "notice" }> => ({
  kind: "notice",
  id: `n${++noticeSeq}`,
  tone,
  text,
});

/** main から届くイベントを反映するだけの純関数(レンダラは状態を持たない: §16.4) */
export function applyEvent(s: EventState, e: UiEvent): EventState {
  if (e.type === "rewind_request")
    return put(s, e.sessionId, { ...view(s, e.sessionId), rewind: e });
  switch (e.type) {
    case "workflow":
      return put(s, e.sessionId, {
        ...view(s, e.sessionId),
        workflow: e,
        items:
          view(s, e.sessionId).workflow?.phase === e.phase ||
          ["off", "classify"].includes(e.phase)
            ? view(s, e.sessionId).items
            : [
                ...view(s, e.sessionId).items,
                { ...notice("dim", `Workflow · ${e.phase}`), phase: e.phase },
              ],
      });
    case "agent_step":
      return put(s, e.sessionId, {
        ...view(s, e.sessionId),
        agentSteps: { ...view(s, e.sessionId).agentSteps, [e.agentId]: e },
        activeAgent: e.agentId,
      });
    case "repository_progress":
      return { ...s, repositoryProgress: e.message };
    case "receipt_history":
      return put(s, e.sessionId, {
        ...view(s, e.sessionId),
        receipts: e.receipts,
      });
    case "receipt":
      return put(s, e.receipt.sessionId, {
        ...view(s, e.receipt.sessionId),
        receipts: [...(view(s, e.receipt.sessionId).receipts ?? []), e.receipt],
      });
    case "usage":
      return { ...s, usage: { ...s.usage, [e.provider]: e } };
    case "state":
      return { ...s, app: e.state };
    case "transcript":
      return put(s, e.sessionId, { ...view(s, e.sessionId), items: e.items });
    case "user_message":
      return put(
        s,
        e.sessionId,
        withItem(view(s, e.sessionId), {
          kind: "user",
          id: e.messageId,
          text: e.text,
          ...(e.images?.length ? { images: e.images } : {}),
        }),
      );
    case "turn": {
      const v = view(s, e.sessionId);
      const next: SessionView = {
        ...v,
        running: e.status === "running",
        rewind: e.status === "idle" ? undefined : v.rewind,
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
    case "tool_progress": {
      const v = view(s, e.sessionId);
      return put(s, e.sessionId, {
        ...v,
        step: v.step
          ? { ...v.step, index: e.index, total: e.total }
          : undefined,
      });
    }
    case "step":
      return put(s, e.sessionId, {
        ...view(s, e.sessionId),
        stepCount: e.round,
        step: { step: e.step, node: e.node, round: e.round },
        activeAgent: "main",
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
          detail: detailInput(e.tool, e.input),
          todos: e.tool === "TodoWrite" ? parseTodos(e.input) : undefined,
          question:
            e.tool === "AskUserQuestion"
              ? parseQuestionChoices(e.input)
              : undefined,
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
          oneTime: e.oneTime,
          receiptId: e.receiptId,
          tool: e.tool,
          summary: e.summary,
          plan: e.plan,
          agentId: e.agentId,
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
    case "mcp": {
      const v = view(s, e.sessionId);
      const next = {
        ...v,
        mcp: { servers: e.servers, prompts: e.prompts },
      };
      return put(
        s,
        e.sessionId,
        e.show
          ? withItem(next, {
              kind: "mcp",
              id: `m${++noticeSeq}`,
              servers: e.servers,
            })
          : next,
      );
    }
    case "notice":
    case "error": {
      const id = e.sessionId ?? s.app?.currentSessionId;
      return id
        ? put(
            s,
            id,
            withItem(view(s, id), {
              ...notice(e.type === "notice" ? e.tone : "err", e.message),
              ...(e.type === "notice" && e.presentation
                ? { presentation: e.presentation }
                : {}),
            }),
          )
        : s;
    }
    case "agent": {
      if (!e.sessionId) return s;
      const v = view(s, e.sessionId);
      return put(s, e.sessionId, {
        ...v,
        agents: {
          ...v.agents,
          [e.agentId]: { ...v.agents?.[e.agentId], ...e },
        },
      });
    }
    case "agent_text": {
      const v = view(s, e.sessionId),
        agent = v.agents?.[e.agentId];
      if (!agent) return s;
      return put(s, e.sessionId, {
        ...v,
        agents: {
          ...v.agents,
          [e.agentId]: { ...agent, text: (agent.text ?? "") + e.text },
        },
      });
    }
    case "agent_transcript": {
      const v = view(s, e.sessionId),
        agent = v.agents?.[e.agentId];
      return agent
        ? put(s, e.sessionId, {
            ...v,
            agents: { ...v.agents, [e.agentId]: { ...agent, items: e.items } },
          })
        : s;
    }
  }
}

export interface Prefs {
  sidebarWidth?: number;
  heroOpen: boolean;
  sidebarOpen: boolean;
  collapsed: Record<string, boolean>;
  sort: "recent" | "name";
  search: string;
  pickerOpen: boolean;
}
const PREFS_KEY = "xharness.prefs";
function loadPrefs(): Prefs {
  const base: Prefs = {
    heroOpen: true,
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
      heroOpen: saved.heroOpen ?? true,
      sidebarOpen: saved.sidebarOpen ?? base.sidebarOpen,
      sidebarWidth:
        typeof saved.sidebarWidth === "number"
          ? Math.max(200, Math.min(400, saved.sidebarWidth))
          : 252,
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
        sidebarWidth: p.sidebarWidth,
        heroOpen: p.heroOpen,
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
  /** 受け付けられたら true。断られたら false(入力欄は文を戻す) */
  send(
    text: string,
    images?: import("../../shared/images.js").ImageAttachment[],
  ): Promise<boolean>;
  abort(): void;
  respond(decision: PermissionDecision): void;
  newSession(
    workspaceId: string | null,
    readOnly?: boolean,
    isolated?: boolean,
    baseBranch?: string,
    newBranch?: string,
  ): Promise<void>;
  openSession(id: string): void;
  closeSession(id: string): void;
  deleteSession(id: string): Promise<boolean>;
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
  async send(text, images) {
    const trimmed = text.trim();
    if (!trimmed && !images?.length) return false;
    let id = get().app?.currentSessionId ?? null;
    if (!id) {
      const created = await window.harness.command({
        type: "new_session",
        workspaceId: null,
      });
      if (!created.ok || !created.sessionId) {
        if (!created.ok && !REPORTED_ERRORS.includes(created.error))
          get().apply({ type: "error", message: created.error });
        return false;
      }
      id = created.sessionId;
    }
    const sessionId = id;
    const result = await window.harness.command({
      type: "send",
      sessionId,
      text: trimmed,
      ...(images?.length ? { images } : {}),
    });
    if (!result.ok && !REPORTED_ERRORS.includes(result.error))
      get().apply({ type: "error", sessionId, message: result.error });
    return result.ok;
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
  async newSession(workspaceId, readOnly, isolated, baseBranch, newBranch) {
    const result = await window.harness.command({
      type: "new_session",
      workspaceId,
      readOnly,
      isolated,
      baseBranch,
      newBranch,
    });
    if (!result.ok && !REPORTED_ERRORS.includes(result.error))
      get().apply({ type: "error", message: result.error });
  },
  openSession(id) {
    void window.harness.command({ type: "open_session", sessionId: id });
  },
  closeSession(id) {
    void window.harness.command({ type: "close_session", sessionId: id });
  },
  async deleteSession(id) {
    const result = await window.harness.command({
      type: "delete_session",
      sessionId: id,
      confirmed: true,
    });
    if (!result.ok) {
      get().apply({ type: "error", sessionId: id, message: result.error });
      return false;
    }
    set((state) => {
      const views = { ...state.views };
      delete views[id];
      return { views };
    });
    return true;
  },
  async pickFolder() {
    const r = await window.harness.command({ type: "pick_folder" });
    return r.ok ? r.workspaceId : undefined;
  },
}));
