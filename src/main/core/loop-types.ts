import { type ContentBlock, type Message, type Usage } from "./types.js";
import {
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
  type ReasoningEffort,
} from "../providers/provider.js";
import {
  type Tool,
  type ToolCall,
  type ToolOutput,
  type ToolRegistry,
} from "../tools/registry.js";
import { type HookResult, type Immutable } from "../hooks/step-hooks.js";
import { type Route, type Router } from "./router.js";

export type StepName =
  "context" | "model" | "tool_use" | "gate" | "act" | "receipt";
export type StopCause = string;
export type StepOutcome =
  | { kind: "next"; to: StepName }
  | { kind: "retry"; afterMs: number }
  | { kind: "fallback"; to: StepName; reason: string }
  | { kind: "stop"; reason: StopCause };
export interface Step {
  name: StepName;
  run(ctx: LoopContext, signal: AbortSignal): Promise<StepOutcome>;
}
export interface Receipt {
  error?: import("../tools/errors.js").ToolFailure;
  input?: unknown;
  output?: string;
  round: number;
  provider: string;
  model: string;
  tool?: string;
  step?: StepName;
  timing?: "before" | "after";
  detail?: string;
  decision: string;
  startedAt: string;
  completedAt: string;
  usage?: Usage;
}
export type Completion = Extract<ProviderEvent, { type: "message_done" }>;
export interface PendingCall {
  errorKind?: import("../tools/errors.js").ErrorKind;
  call: ToolCall;
  tool?: Tool;
  error?: string;
  allowed?: boolean;
  result?: ToolOutput;
  counted?: boolean;
}
export interface LoopContext {
  toolFailures?: Map<
    string,
    { kind: import("../tools/errors.js").ErrorKind; count: number }
  >;
  failureQuestion?: string;
  contextView?: Message[];
  contextLength?: number;
  route?: Route;
  fallbackRoute?: Route;
  visitedModels: Set<string>;
  limitedProviders: Set<import("./types.js").ProviderId>;
  round: number;
  messages: Message[];
  request?: ProviderRequest;
  completion?: Completion;
  stopCause?: StopCause;
  receipts: Receipt[];
  pending: PendingCall[];
  startedAt: string;
  recorded: boolean;
  resultsAppended: boolean;
  injections: string[];
  modelAttempts: number;
  lastCall: string;
  repeated: number;
  consecutiveErrors: number;
  continuations: number;
}
export type HookContext = Immutable<
  Pick<
    LoopContext,
    "round" | "messages" | "request" | "completion" | "stopCause"
  > & { calls: ToolCall[] }
>;
export type StepHook = (
  step: StepName,
  ctx: HookContext,
  signal: AbortSignal,
) => Promise<HookResult>;
export interface LoopOptions {
  checkpoint?: import("../tools/registry.js").WriteCheckpoint;
  prepareContext?(
    messages: Message[],
    route: Route,
    signal: AbortSignal,
    context?: { system: string; tools: import("./types.js").ToolSpec[] },
  ): Promise<{ messages: Message[]; stop?: string }>;
  provider: Provider;
  router?: Router;
  sessionId?: string;
  retryWaitSec?: number;
  onFallback?(route: Route): Promise<void> | void;
  model: string;
  system: string;
  messages: Message[];
  tools: ToolRegistry;
  permission(
    call: ToolCall,
    signal: AbortSignal,
    context?: { forceAsk?: boolean },
  ): Promise<boolean>;
  beforeStep?: StepHook;
  afterStep?: StepHook;
  onEvent?(
    event:
      | ProviderEvent
      | { type: "step"; step: StepName; round: number }
      | { type: "tool_progress"; index: number; total: number }
      | { type: "receipt"; receipt: Receipt },
  ): void;
  /**
   * 各周の STEP 1 で呼ばれ、その周のモデルと effort を返す。
   * 実行中にモデルを切り替えても、進行中の呼び出しは中断せず次の周から反映する(§16.8)。
   */
  current?(): { model: string; reasoning?: { effort: ReasoningEffort } };
  maxRounds?: number;
  maxOutputTokens?: number;
  reasoning?: { effort: ReasoningEffort };
  redact?(text: string): string;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}
export function createLoopContext(options: LoopOptions): LoopContext {
  if (
    !Number.isSafeInteger(options.maxRounds ?? 100) ||
    (options.maxRounds ?? 100) < 1
  )
    throw new Error("Invalid round limit");
  return {
    visitedModels: new Set(),
    limitedProviders: new Set(),
    round: 1,
    messages: structuredClone(options.messages),
    receipts: [],
    pending: [],
    startedAt: new Date().toISOString(),
    recorded: false,
    resultsAppended: false,
    injections: [],
    modelAttempts: 0,
    lastCall: "",
    repeated: 0,
    consecutiveErrors: 0,
    continuations: 0,
  };
}
export function beginNextRound(ctx: LoopContext) {
  ctx.round++;
  ctx.startedAt = new Date().toISOString();
  ctx.completion = undefined;
  ctx.request = undefined;
  ctx.pending = [];
  ctx.recorded = false;
  ctx.resultsAppended = false;
  ctx.injections = [];
  ctx.modelAttempts = 0;
}
export function toolCalls(message: Message): PendingCall[] {
  return message.content
    .filter(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
        b.type === "tool_use",
    )
    .map((b) => ({ call: { id: b.id, name: b.name, input: b.input } }));
}
