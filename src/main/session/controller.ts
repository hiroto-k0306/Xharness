import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { redact } from "../core/redact.js";
import { runTurn, type Receipt as LoopReceipt } from "../core/loop.js";
import { type Message } from "../core/types.js";
import { type Provider } from "../providers/provider.js";
import { FileAccess, fileTools } from "../tools/files.js";
import { type ToolRegistry } from "../tools/registry.js";
import { shellSearchTools } from "../tools/shell-search.js";
import {
  STEP_NODES,
  type AppState,
  type CommandResult,
  type HarnessCommand,
  type PermissionDecision,
  type Receipt,
  type SessionStatus,
  type UiEvent,
} from "../../shared/ipc.js";
import {
  SessionStore,
  usedProviders,
  WorkspaceStore,
  type StoredSession,
} from "./store.js";
import { summarizeInput } from "../../shared/summary.js";
import { itemsFromMessages } from "./transcript.js";

export interface Host {
  pickFolder(): Promise<string | undefined>;
}
export interface ControllerOptions {
  provider: Provider;
  model: string;
  /** ~/.xharness/(--fake のときは別の場所) */
  home: string;
  host: Host;
  emit(event: UiEvent): void;
  secrets?: string[];
  fake: boolean;
  version: string;
  createTools?(cwd: string, readOnly: boolean): ToolRegistry;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

interface Runtime {
  messages: Message[];
  loaded: boolean;
  persisted: number;
  abort?: AbortController;
  status: SessionStatus;
  pending?: {
    requestId: string;
    resolve(decision: PermissionDecision): void;
  };
  always: Set<string>;
  tools?: ToolRegistry;
  receiptSeq: number;
  messageSeq: number;
}

const STOP_NOTICE: Record<string, string> = {
  rate_limited: "枠の上限に達しました。時間をおいて再試行してください",
  authentication:
    "認証エラー: 公式 CLI (claude / codex) で更新・再ログインしてから再試行してください",
  transport: "通信に失敗しました",
  protocol: "応答を解釈できませんでした",
  request: "リクエストが拒否されました",
  max_tokens: "出力上限に達しました",
  refusal: "モデルが応答を拒否しました",
  round_limit: "周回数の上限に達しました",
  consecutive_errors: "連続エラーのため停止しました",
  incomplete_response: "応答が途中で終了しました",
  step_failed: "内部エラーで停止しました",
  hook_failed: "フックの失敗で停止しました",
};
const pad = (n: number) => "#" + String(n).padStart(4, "0");

/** electron を import しない。UI(renderer)とは UiEvent / HarnessCommand だけで話す。 */
export class SessionController {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly sessions: SessionStore;
  private readonly workspaces: WorkspaceStore;
  private current: string | null = null;
  private model: string;
  private readonly clean: (text: string) => string;

  constructor(private readonly options: ControllerOptions) {
    this.sessions = new SessionStore(options.home);
    this.workspaces = new WorkspaceStore(options.home);
    this.model = options.model;
    this.clean = (text) => redact(text, options.secrets ?? []);
  }

  async init() {
    await Promise.all([this.sessions.load(), this.workspaces.load()]);
  }

  private runtime(id: string): Runtime {
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = {
        messages: [],
        loaded: false,
        persisted: 0,
        status: "idle",
        always: new Set(),
        receiptSeq: 0,
        messageSeq: 0,
      };
      this.runtimes.set(id, rt);
    }
    return rt;
  }
  private async load(id: string): Promise<Runtime> {
    const rt = this.runtime(id);
    if (!rt.loaded) {
      rt.messages = await this.sessions.messages(id);
      rt.persisted = rt.messages.length;
      rt.loaded = true;
    }
    return rt;
  }

  async state(): Promise<AppState> {
    const workspaces = await this.workspaces.summaries();
    const branch = new Map(workspaces.map((w) => [w.id, w.branch]));
    return {
      sessions: this.sessions.list().map((s) => ({
        ...s,
        status: this.runtimes.get(s.id)?.status ?? "idle",
        branch: s.workspaceId ? branch.get(s.workspaceId) : undefined,
      })),
      workspaces,
      currentSessionId: this.current,
      model: this.model,
      fake: this.options.fake,
      version: this.options.version,
    };
  }
  private async emitState() {
    this.options.emit({ type: "state", state: await this.state() });
  }

  async handle(command: HarnessCommand): Promise<CommandResult> {
    try {
      switch (command.type) {
        case "ready": {
          await this.emitState();
          if (this.current) await this.emitTranscript(this.current);
          return { ok: true };
        }
        case "new_session":
          return await this.newSession(command.workspaceId, !!command.readOnly);
        case "open_session": {
          if (!this.sessions.get(command.sessionId))
            return { ok: false, error: "Unknown session" };
          this.current = command.sessionId;
          await this.emitState();
          await this.emitTranscript(command.sessionId);
          return { ok: true, sessionId: command.sessionId };
        }
        case "pick_folder": {
          const folder = await this.options.host.pickFolder();
          if (!folder) return { ok: false, error: "cancelled" };
          const workspaceId = await this.workspaces.add(folder);
          await this.emitState();
          return { ok: true, workspaceId };
        }
        case "forget_workspace":
          await this.workspaces.forget(command.workspaceId);
          await this.emitState();
          return { ok: true };
        case "set_model": {
          const known = this.options.provider
            .models()
            .some((m) => m.id === command.model);
          if (!known) return { ok: false, error: "Unknown model" };
          this.model = command.model; // 次の周の STEP 1 から反映(§16.8)
          await this.emitState();
          return { ok: true };
        }
        case "send":
          return this.send(command.sessionId, command.text);
        case "abort": {
          const rt = this.runtimes.get(command.sessionId);
          rt?.pending?.resolve("deny");
          rt?.abort?.abort();
          return { ok: true };
        }
        case "permission_response": {
          const rt = this.runtimes.get(command.sessionId);
          if (rt?.pending?.requestId !== command.requestId)
            return { ok: false, error: "No such permission request" };
          rt.pending.resolve(command.decision);
          return { ok: true };
        }
      }
    } catch {
      // 例外の本文には資格情報やパスが入りうるので、画面には汎用文だけを返す。
      return { ok: false, error: "Command failed" };
    }
  }

  private async newSession(
    workspaceId: string | null,
    readOnly: boolean,
  ): Promise<CommandResult> {
    const id = randomUUID().slice(0, 8);
    let cwd: string;
    if (workspaceId) {
      const ws = this.workspaces.get(workspaceId);
      if (!ws) return { ok: false, error: "Unknown workspace" };
      cwd = ws.root;
      await this.workspaces.touch(workspaceId);
    } else {
      // §18.5: 指定なしのセッションはセッション専用の空フォルダで作業する
      cwd = join(this.options.home, "scratch", id);
      await mkdir(cwd, { recursive: true });
    }
    const now = Date.now();
    const session: StoredSession = {
      id,
      title: "New session",
      workspaceId,
      cwd,
      readOnly,
      createdAt: now,
      updatedAt: now,
      providers: [],
    };
    await this.sessions.save(session);
    this.runtime(id).loaded = true;
    this.current = id;
    await this.emitState();
    this.options.emit({ type: "transcript", sessionId: id, items: [] });
    return { ok: true, sessionId: id };
  }

  private async emitTranscript(id: string) {
    const rt = this.runtimes.get(id);
    if (rt && rt.status !== "idle") return; // 実行中は画面側が最新を持っている
    const loaded = await this.load(id);
    this.options.emit({
      type: "transcript",
      sessionId: id,
      items: itemsFromMessages(loaded.messages),
    });
  }

  private async send(sessionId: string, text: string): Promise<CommandResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: "Unknown session" };
    const rt = await this.load(sessionId);
    if (rt.status !== "idle")
      return { ok: false, error: "Turn already running" };
    rt.status = "running";
    void this.runSession(session, rt, text);
    return { ok: true, sessionId };
  }

  private async system(cwd: string): Promise<string> {
    let system = `You are a coding agent working in ${cwd}. Use Read before modifying existing files. Bash executes PowerShell 7. Tool dates use ISO 8601. Respect project instructions. Reply in Japanese unless asked otherwise.`;
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      try {
        system +=
          `\n\n${name}:\n` +
          this.clean(await readFile(resolve(cwd, name), "utf8"));
      } catch {
        /* 任意のファイル */
      }
    }
    return system;
  }

  private async runSession(session: StoredSession, rt: Runtime, text: string) {
    const { emit } = this.options;
    const sessionId = session.id;
    const clean = this.clean;
    const abort = new AbortController();
    rt.abort = abort;
    const calls: { callId: string; receiptId: string }[] = [];
    const receiptByCall = new Map<string, string>();
    let buffer = "";
    const messageId = () => `${sessionId}-m${rt.messageSeq}`;
    const flush = () => {
      if (buffer)
        emit({
          type: "text_delta",
          sessionId,
          messageId: messageId(),
          text: clean(buffer),
        });
      buffer = "";
    };
    const first = rt.messages.length === 0;
    rt.messages.push({
      role: "user",
      content: [{ type: "text", text: clean(text) }],
    });
    if (first) {
      session = {
        ...session,
        title:
          clean(text).replace(/\s+/g, " ").trim().slice(0, 40) || session.title,
      };
      await this.sessions.save(session);
    }
    emit({ type: "turn", sessionId, status: "running" });
    await this.emitState();
    let stopCause = "step_failed";
    try {
      rt.tools ??= (this.options.createTools ?? defaultTools)(
        session.cwd,
        session.readOnly,
      );
      const result = await runTurn(
        {
          provider: this.options.provider,
          model: this.model,
          system: await this.system(session.cwd),
          messages: rt.messages,
          tools: rt.tools,
          redact: clean,
          sleep: this.options.sleep,
          permission: (call, signal) =>
            this.askPermission(
              session,
              rt,
              call,
              receiptByCall.get(call.id),
              signal,
            ),
          onEvent: (event) => {
            switch (event.type) {
              case "step":
                emit({
                  type: "step",
                  sessionId,
                  step: (STEP_NODES.indexOf(event.step) + 1) as 1,
                  node: event.step,
                  round: event.round,
                });
                break;
              case "text_delta": {
                buffer += event.text;
                const cut = Math.max(
                  buffer.lastIndexOf(" "),
                  buffer.lastIndexOf("\n"),
                  buffer.lastIndexOf("\t"),
                );
                if (cut >= 0) {
                  const head = buffer.slice(0, cut + 1);
                  buffer = buffer.slice(cut + 1);
                  emit({
                    type: "text_delta",
                    sessionId,
                    messageId: messageId(),
                    text: clean(head),
                  });
                }
                break;
              }
              case "message_done":
                flush();
                rt.messageSeq++;
                break;
              case "tool_use": {
                const receiptId = pad(++rt.receiptSeq);
                calls.push({ callId: event.id, receiptId });
                receiptByCall.set(event.id, receiptId);
                emit({
                  type: "tool_call",
                  sessionId,
                  receiptId,
                  provider: this.options.provider.id,
                  tool: event.name,
                  input: safeInput(event.input, clean),
                });
                break;
              }
              case "receipt": {
                const r = event.receipt;
                if (r.provider === "hook") break;
                if (r.provider === "tool") {
                  const call = calls.shift();
                  if (call)
                    emit({
                      type: "tool_result",
                      sessionId,
                      receiptId: call.receiptId,
                      isError: r.decision === "error",
                    });
                }
                emit({
                  type: "receipt",
                  receipt: toReceipt(r, sessionId, pad(++rt.receiptSeq)),
                });
                break;
              }
              case "rate_limited":
                emit({
                  type: "error",
                  sessionId,
                  message: `枠の上限(429)。待ち時間: ${event.retryAfterSec ?? "不明"} 秒`,
                });
                break;
              case "error":
                emit({
                  type: "error",
                  sessionId,
                  message: clean(event.error.message),
                });
                break;
            }
          },
        },
        abort.signal,
      );
      flush();
      rt.messages = result.messages;
      stopCause = result.stopCause;
    } catch {
      flush();
      emit({ type: "error", sessionId, message: "内部エラーで停止しました" });
    }
    try {
      await this.sessions.append(
        sessionId,
        rt.messages.slice(rt.persisted),
        clean,
      );
      rt.persisted = rt.messages.length;
      await this.sessions.save({
        ...session,
        updatedAt: Date.now(),
        providers: usedProviders(rt.messages, session.providers),
      });
    } catch {
      emit({ type: "error", sessionId, message: "履歴の保存に失敗しました" });
    }
    rt.abort = undefined;
    rt.pending = undefined;
    rt.status = "idle";
    const notice = STOP_NOTICE[stopCause];
    if (notice && stopCause !== "aborted")
      emit({ type: "error", sessionId, message: notice });
    emit({ type: "turn", sessionId, status: "idle", stopCause });
    await this.emitState();
  }

  private async askPermission(
    session: StoredSession,
    rt: Runtime,
    call: { name: string; input: unknown },
    receiptId: string | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    // §9「このセッション中許可」。Phase 4 までルール機能は無く、既定は全ツール ask。
    if (rt.always.has(call.name)) return true;
    const requestId = randomUUID().slice(0, 8);
    rt.status = "ask";
    this.options.emit({
      type: "permission_request",
      sessionId: session.id,
      requestId,
      receiptId,
      tool: call.name,
      summary: summarizeInput(call.name, call.input, this.clean, 300),
    });
    void this.emitState();
    const decision = await new Promise<PermissionDecision>(
      (resolveDecision) => {
        const done = (d: PermissionDecision) => {
          signal.removeEventListener("abort", onAbort);
          rt.pending = undefined;
          resolveDecision(d);
        };
        const onAbort = () => done("deny");
        rt.pending = { requestId, resolve: done };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      },
    );
    rt.status = "running";
    if (decision === "always") rt.always.add(call.name);
    this.options.emit({
      type: "permission_resolved",
      sessionId: session.id,
      requestId,
      decision,
    });
    void this.emitState();
    return decision !== "deny";
  }
}

function safeInput(input: unknown, clean: (s: string) => string): unknown {
  try {
    return JSON.parse(clean(JSON.stringify(input) ?? "null"));
  } catch {
    return clean(String(input));
  }
}

function toReceipt(r: LoopReceipt, sessionId: string, id: string): Receipt {
  const durationMs = Math.max(
    0,
    Date.parse(r.completedAt) - Date.parse(r.startedAt),
  );
  const isTool = r.provider === "tool";
  return {
    id,
    sessionId,
    ts: Date.parse(r.completedAt),
    provider: isTool ? "harness" : (r.provider as Receipt["provider"]),
    model: r.model,
    kind: isTool ? "tool" : "model_call",
    tool: r.tool,
    decision: isTool ? (r.decision === "error" ? "deny" : "allow") : undefined,
    durationMs,
    usage: r.usage && {
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
    },
    summary: `${r.tool ?? r.model}: ${r.decision}`,
  };
}

export function defaultTools(cwd: string, readOnly: boolean): ToolRegistry {
  const access = new FileAccess(cwd);
  const all = new Map([...fileTools(access), ...shellSearchTools(cwd)]);
  if (!readOnly) return all;
  // 読み取り専用で開いたセッションは plan 相当: 書き込み系ツールを渡さない(§9.1, §18.2)
  return new Map([...all].filter(([, tool]) => tool.readOnly));
}
