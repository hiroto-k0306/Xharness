import { AsyncLocalStorage } from "node:async_hooks";
import { type LlmCalls } from "../../shared/llm-calls.js";

export class LlmBudgetError extends Error {
  constructor(readonly reason = "budget_exceeded") {
    super(reason);
  }
}
/** Shared by all providers/children in one parent turn, independent of tracing. */
export class LlmBudget {
  stopCause?: string;
  private closed = false;
  constructor(
    readonly calls: LlmCalls,
    private readonly abort: AbortController,
    private readonly changed: (calls: LlmCalls) => void = () => {},
    readonly flush: () => Promise<void> = async () => {},
  ) {}
  reserve(signal: AbortSignal, simulated = false) {
    if (this.stopCause) throw new LlmBudgetError(this.stopCause);
    if (this.closed) throw new LlmBudgetError("aborted");
    signal.throwIfAborted();
    if (
      (this.calls.llmCallsPerTurn > 0 &&
        this.calls.turn >= this.calls.llmCallsPerTurn) ||
      (this.calls.llmCallsPerSession > 0 &&
        this.calls.session >= this.calls.llmCallsPerSession)
    ) {
      this.stopCause = "budget_exceeded";
      this.abort.abort();
      throw new LlmBudgetError();
    }
    this.calls.turn++;
    this.calls.session++;
    if (simulated) {
      this.calls.simulatedTurn++;
      this.calls.simulatedSession++;
    }
    this.changed({ ...this.calls });
  }
  storageFailed() {
    this.stopCause = "budget_storage_failed";
    this.abort.abort();
  }
  close() {
    this.closed = true;
  }
}
const scope = new AsyncLocalStorage<LlmBudget>();
export const withLlmBudget = <T>(budget: LlmBudget, run: () => T): T =>
  scope.run(budget, run);
export function reserveLlmCall(signal: AbortSignal, simulated = false) {
  scope.getStore()?.reserve(signal, simulated);
}
export const llmStopCause = () => scope.getStore()?.stopCause;
export const flushLlmCalls = async () => scope.getStore()?.flush();
