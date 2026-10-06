import {
  BoundaryError,
  type Action,
  type ConnectionMode,
  type Input,
  type Outcome,
  type Scope,
} from "./contracts.js";

export interface IntentLedger {
  /** Atomic durable claim BEFORE side effects. false includes pending from restart. */
  claim(scope: Scope, action: Action): Promise<boolean>;
  complete(scope: Scope, action: Action): Promise<void>;
}
export interface XTool {
  validate(input: unknown): boolean;
  execute(input: unknown, signal: AbortSignal): Promise<string>;
}
export class ToolGateway {
  constructor(
    private scope: Scope,
    private tools: Record<string, XTool>,
    private ledger: IntentLedger,
    private authorize: (scope: Scope, action: Action) => Promise<boolean>,
  ) {
    this.scope = structuredClone(scope);
  }
  async execute(
    scope: Scope,
    action: Action,
    signal: AbortSignal,
  ): Promise<string> {
    if (
      scope.taskId !== this.scope.taskId ||
      scope.sessionId !== this.scope.sessionId ||
      scope.requestId !== this.scope.requestId
    )
      throw new BoundaryError("session-mismatch");
    if (signal.aborted) throw new BoundaryError("cancelled");
    const tool = Object.hasOwn(this.tools, action.tool)
      ? this.tools[action.tool]
      : undefined;
    if (!tool || /^(auth|permission|billing)([.:_-]|$)/i.test(action.tool))
      throw new BoundaryError("unsupported");
    // Snapshot before awaits: authorization and execution must see identical arguments.
    const frozen = structuredClone(action);
    if (!tool.validate(frozen.input)) throw new BoundaryError("malformed");
    if (!(await this.authorize(scope, structuredClone(frozen))))
      throw new BoundaryError("denied");
    if (signal.aborted) throw new BoundaryError("cancelled");
    if (!(await this.ledger.claim(scope, frozen)))
      throw new BoundaryError("uncertain");
    if (signal.aborted) throw new BoundaryError("cancelled");
    // Failure/abort after claim stays pending; never replay an uncertain side effect.
    const result = await tool.execute(frozen.input, signal);
    if (signal.aborted) throw new BoundaryError("cancelled");
    await this.ledger.complete(scope, frozen);
    return result;
  }
}

/** Offline ledger; persist its snapshot across simulated restart. Production needs a durable binding. */
export class MemoryIntentLedger implements IntentLedger {
  constructor(readonly records = new Map<string, "pending" | "completed">()) {}
  private key(scope: Scope, action: Action) {
    return JSON.stringify([scope.taskId, scope.sessionId, action.id]);
  }
  async claim(scope: Scope, action: Action) {
    const key = this.key(scope, action);
    if (this.records.has(key)) return false;
    this.records.set(key, "pending");
    return true;
  }
  async complete(scope: Scope, action: Action) {
    this.records.set(this.key(scope, action), "completed");
  }
}

export class RunBoundary {
  private active = new Set<string>();
  private seen = new Set<string>();
  private paused = new Set<string>();
  /** Explicit caller action. Never starts a request, falls back, or guesses reset time. */
  acknowledgeQuota(sessionId: string) {
    this.paused.delete(sessionId);
  }
  async run(
    mode: ConnectionMode,
    input: Input,
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<Partial<Outcome>>,
  ): Promise<Outcome> {
    const started = Date.now();
    const base: Outcome = {
      taskId: input.taskId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      mode,
      status: "failed",
      elapsedMs: 0,
      measurement: null,
      quota: null,
    };
    const key = JSON.stringify([input.sessionId, input.requestId]);
    if (this.paused.has(input.sessionId))
      return { ...base, status: "quota-paused", error: "quota" };
    if (this.active.has(input.sessionId) || this.seen.has(key))
      return { ...base, error: "duplicate" };
    if (
      !Number.isFinite(input.timeoutMs) ||
      input.timeoutMs <= 0 ||
      input.timeoutMs > 300_000
    )
      return { ...base, error: "unsupported" };
    this.active.add(input.sessionId);
    this.seen.add(key);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectStop: (e: BoundaryError) => void = () => {};
    const stop = new Promise<never>((_, reject) => {
      rejectStop = reject;
    });
    const abort = () => {
      controller.abort();
      rejectStop(new BoundaryError("cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new BoundaryError("cancelled");
      timer = setTimeout(() => {
        controller.abort();
        rejectStop(new BoundaryError("timeout"));
      }, input.timeoutMs);
      const result = await Promise.race([work(controller.signal), stop]);
      if (controller.signal.aborted) throw new BoundaryError("cancelled");
      if (result.status === "quota-paused") this.paused.add(input.sessionId);
      // Identity is always X-owned; transport cannot overwrite it.
      return {
        ...base,
        ...result,
        taskId: input.taskId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        mode,
        elapsedMs: Date.now() - started,
      };
    } catch (e) {
      const error = e instanceof BoundaryError ? e.code : "transport";
      return {
        ...base,
        error,
        status:
          error === "timeout"
            ? "timeout"
            : error === "cancelled"
              ? "cancelled"
              : "failed",
        elapsedMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.abort();
      this.active.delete(input.sessionId);
    }
  }
}
