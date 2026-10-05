import { type AutoRefresh } from "../auth/auto-refresh.js";
import {
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
} from "./provider.js";

async function waitForRefresh<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Aborted"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Wraps all model consumers, including workers, compaction and hosted tools. */
export class RefreshingProvider implements Provider {
  readonly id;
  constructor(
    private readonly inner: Provider,
    private readonly refresh: AutoRefresh,
  ) {
    this.id = inner.id;
  }
  models() {
    return this.inner.models();
  }
  async *stream(
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    signal.throwIfAborted();
    const before = await this.refresh.expiry(this.id);
    let refreshed = false;
    if (before !== undefined && before <= Date.now()) {
      const result = await waitForRefresh(
        this.refresh.refresh(this.id, before),
        signal,
      );
      signal.throwIfAborted();
      yield { type: "auth_refresh", provider: this.id, ...result };
      if (result.result !== "success") {
        yield this.failure();
        return;
      }
      refreshed = true;
    }
    for await (const event of this.inner.stream(request, signal)) {
      if (!refreshed && event.type === "error" && event.error.status === 401) {
        const result = await waitForRefresh(
          this.refresh.refresh(this.id, before),
          signal,
        );
        signal.throwIfAborted();
        yield { type: "auth_refresh", provider: this.id, ...result };
        if (result.result === "success") {
          yield* this.inner.stream(request, signal);
        } else yield this.failure();
        return;
      }
      yield event;
    }
  }
  private failure(): ProviderEvent {
    return {
      type: "error",
      error: {
        kind: "authentication",
        retryable: false,
        message:
          this.id === "claude"
            ? "認証を更新できませんでした。公式CLIで claude auth login を実行してください。"
            : "認証を更新できませんでした。公式CLIで codex login を実行してください。",
      },
    };
  }
}
