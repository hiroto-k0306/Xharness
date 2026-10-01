import { readClaudeAccessToken } from "../../auth/claude-oauth.js";
import {
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
} from "../provider.js";
import { toClaudeRequest } from "./convert.js";
import { claudeRateLimit } from "./rate-limit.js";
import { decodeClaudeStream } from "./stream.js";

export interface ClaudeAdapterOptions {
  fetcher?: typeof fetch;
  getAccessToken?: () => Promise<string>;
  now?: () => number;
}

export class ClaudeAdapter implements Provider {
  readonly id = "claude";
  constructor(private readonly options: ClaudeAdapterOptions = {}) {}
  models() {
    return [
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ].map((id) => ({ id, contextTokens: null }));
  }
  async *stream(
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    let stage: "request" | "authentication" | "transport" | "protocol" =
      "request";
    try {
      signal.throwIfAborted();
      const body = JSON.stringify(toClaudeRequest(request));
      stage = "authentication";
      const token = await (
        this.options.getAccessToken ?? readClaudeAccessToken
      )();
      signal.throwIfAborted();
      stage = "transport";
      const response = await (this.options.fetcher ?? fetch)(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            Authorization: `Bearer ${token}`,
            "anthropic-beta": "oauth-2025-04-20",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) {
          yield {
            type: "rate_limited",
            ...claudeRateLimit(
              response.headers,
              (this.options.now ?? Date.now)(),
            ),
          };
        } else {
          yield {
            type: "error",
            error: {
              kind: [401, 403].includes(response.status)
                ? "authentication"
                : "request",
              message: "Claude request rejected",
              status: response.status,
              retryable: response.status >= 500,
            },
          };
        }
        return;
      }
      stage = "protocol";
      for await (const event of decodeClaudeStream(response)) {
        signal.throwIfAborted();
        yield event;
      }
    } catch {
      // Never expose credential values or provider/transport exception text.
      yield {
        type: "error",
        error: {
          kind: signal.aborted ? "aborted" : stage,
          message: signal.aborted
            ? "Claude request aborted"
            : `Claude ${stage} failed`,
          retryable: !signal.aborted && stage === "transport",
        },
      };
    }
  }
}
