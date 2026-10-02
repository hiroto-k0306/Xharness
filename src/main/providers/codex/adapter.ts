import { traceStream, captureTraceResponse } from "../../core/trace.js";
import { randomUUID } from "node:crypto";
import {
  readCodexCredentials,
  type CodexCredentials,
} from "../../auth/codex-oauth.js";
import {
  loadModelCatalog,
  type CatalogModel,
} from "../../config/model-catalog.js";
import {
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
} from "../provider.js";
import { toCodexRequest } from "./convert.js";
import { decodeCodexStream } from "./stream.js";
import { codexRetryAfter, codexUsage } from "./usage.js";

export interface CodexAdapterOptions {
  fetcher?: typeof fetch;
  getCredentials?: () => Promise<CodexCredentials>;
  catalog?: CatalogModel[];
  now?: () => number;
}
export class CodexAdapter implements Provider {
  readonly id = "codex";
  private readonly threadId = randomUUID();
  private readonly catalog: CatalogModel[];
  constructor(private readonly options: CodexAdapterOptions = {}) {
    this.catalog = options.catalog ?? loadModelCatalog();
  }
  models() {
    return this.catalog
      .filter((m) => m.provider === "codex" && m.enabled)
      .map((m) => ({ id: m.id, contextTokens: m.contextTokens }));
  }
  async *stream(
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    yield* traceStream(
      "codex",
      { internal: request },
      this.events(request, signal),
    );
  }
  private async *events(
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    let stage: "request" | "authentication" | "transport" | "protocol" =
      "request";
    try {
      signal.throwIfAborted();
      const body = JSON.stringify(toCodexRequest(request, this.catalog));
      captureTraceResponse({ requestBody: body });
      stage = "authentication";
      const auth = await (
        this.options.getCredentials ?? readCodexCredentials
      )();
      signal.throwIfAborted();
      stage = "transport";
      captureTraceResponse({ requestDispatched: true });
      const id = request.sessionId ?? this.threadId;
      const response = await (this.options.fetcher ?? fetch)(
        "https://chatgpt.com/backend-api/codex/responses",
        {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            "chatgpt-account-id": auth.accountId,
            originator: "codex_cli_rs",
            "User-Agent": "codex_cli_rs/0.159.2",
            "session-id": id,
            "thread-id": id,
            "x-client-request-id": randomUUID(),
            "content-type": "application/json",
            Accept: "text/event-stream",
          },
          body,
        },
      );
      captureTraceResponse({ httpStatus: response.status });
      yield {
        type: "usage",
        provider: "codex",
        ...codexUsage(response.headers),
      };
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429)
          yield {
            type: "rate_limited",
            retryAfterSec: codexRetryAfter(
              response.headers,
              (this.options.now ?? Date.now)(),
            ),
          };
        else
          yield {
            type: "error",
            error: {
              kind: [401, 403].includes(response.status)
                ? "authentication"
                : "request",
              message: "Codex request rejected",
              status: response.status,
              retryable: response.status >= 500,
            },
          };
        return;
      }
      stage = "protocol";
      for await (const event of decodeCodexStream(response)) {
        signal.throwIfAborted();
        yield event;
      }
    } catch {
      yield {
        type: "error",
        error: {
          kind: signal.aborted ? "aborted" : stage,
          message: signal.aborted
            ? "Codex request aborted"
            : `Codex ${stage} failed`,
          retryable: !signal.aborted && stage === "transport",
        },
      };
    }
  }
}
