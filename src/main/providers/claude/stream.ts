import {
  type ContentBlock,
  type Usage,
  type WebSource,
} from "../../core/types.js";
import { type ProviderEvent, type StopReason } from "../provider.js";
import { readSse } from "./sse.js";
import { claudeRateLimit } from "./rate-limit.js";
import { tokenMeasurement } from "../token-usage.js";
import { captureTraceUsage } from "../../core/trace.js";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid stream object");
  return value as ObjectValue;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid stream string");
  return value;
}
function usage(value: unknown, previous: Usage): Usage {
  const native = object(value);
  const result = { ...previous };
  result.measurement = tokenMeasurement("claude", {
    ...previous.measurement?.raw,
    ...tokenMeasurement("claude", native).raw,
  });
  if (Array.isArray(native.iterations) && native.iterations.length) {
    const iterations = native.iterations.map((v) =>
      usage(v, { inputTokens: 0, outputTokens: 0 }),
    );
    result.inputTokens = iterations.reduce((n, v) => n + v.inputTokens, 0);
    result.outputTokens = iterations.reduce((n, v) => n + v.outputTokens, 0);
    for (const key of ["cacheReadTokens", "cacheWriteTokens"] as const) {
      if (iterations.every((v) => v[key] !== undefined))
        result[key] = iterations.reduce((n, v) => n + v[key]!, 0);
    }
    captureTraceUsage(result.measurement);
    return result;
  }
  for (const [source, target] of [
    ["input_tokens", "inputTokens"],
    ["output_tokens", "outputTokens"],
    ["cache_read_input_tokens", "cacheReadTokens"],
    ["cache_creation_input_tokens", "cacheWriteTokens"],
  ] as const) {
    if (native[source] !== undefined) {
      const count = native[source];
      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0
      )
        throw new Error("Invalid stream usage");
      result[target] = count;
    }
  }
  captureTraceUsage(result.measurement);
  return result;
}

export async function* decodeClaudeStream(
  response: Response,
): AsyncGenerator<ProviderEvent> {
  const blocks: ContentBlock[] = [];
  type HostedBlock = { type: "hosted_search"; payload: ObjectValue };
  let active:
    | { index: number; block: ContentBlock | HostedBlock; json: string }
    | undefined;
  let nextIndex = 0;
  const sources: WebSource[] = [];
  let searchCalls = 0;
  let started = false;
  let model = "";
  let counts: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason | undefined;
  for await (const event of readSse(response)) {
    const data = object(JSON.parse(event.data));
    switch (data.type) {
      case "message_start": {
        if (started) throw new Error("Duplicate message");
        const message = object(data.message);
        model = string(message.model);
        counts = usage(message.usage, counts);
        started = true;
        break;
      }
      case "content_block_start": {
        if (!started || active || stopReason || data.index !== nextIndex)
          throw new Error("Invalid block sequence");
        const native = object(data.content_block);
        let block: ContentBlock | HostedBlock;
        switch (native.type) {
          case "compaction":
            if (
              typeof native.content !== "string" ||
              typeof native.signature !== "string"
            )
              throw new Error("Invalid compaction block");
            block = {
              type: "compaction",
              provider: "claude",
              payload: structuredClone(native),
            };
            break;
          case "server_tool_use":
          case "web_search_tool_result":
            block = { type: "hosted_search", payload: { ...native } };
            break;
          case "text":
            block = { type: "text", text: string(native.text) };
            break;
          case "tool_use":
            block = {
              type: "tool_use",
              id: string(native.id),
              name: string(native.name),
              input: object(native.input),
            };
            break;
          case "thinking":
          case "redacted_thinking":
            block = {
              type: "reasoning",
              provider: "claude",
              payload: { ...native },
            };
            break;
          default:
            throw new Error("Unsupported Claude block");
        }
        active = { index: nextIndex, block, json: "" };
        break;
      }
      case "content_block_delta": {
        if (!active || data.index !== active.index)
          throw new Error("Delta outside block");
        const delta = object(data.delta);
        const block = active.block;
        if (delta.type === "text_delta" && block.type === "text") {
          const text = string(delta.text);
          block.text += text;
          yield { type: "text_delta", text };
        } else if (
          delta.type === "input_json_delta" &&
          (block.type === "tool_use" || block.type === "hosted_search")
        ) {
          active.json += string(delta.partial_json);
        } else if (
          block.type === "reasoning" &&
          delta.type === "thinking_delta"
        ) {
          const native = object(block.payload);
          const text = string(delta.thinking);
          native.thinking = string(native.thinking) + text;
          yield { type: "reasoning_delta", text };
        } else if (
          block.type === "reasoning" &&
          delta.type === "signature_delta"
        ) {
          const native = object(block.payload);
          native.signature = string(native.signature) + string(delta.signature);
        } else if (delta.type === "citations_delta" && block.type === "text") {
          const citation = object(delta.citation);
          if (
            typeof citation.url === "string" &&
            /^https?:\/\//.test(citation.url)
          )
            sources.push({
              url: citation.url,
              title:
                typeof citation.title === "string"
                  ? citation.title
                  : citation.url,
            });
        } else throw new Error("Unsupported Claude delta");
        break;
      }
      case "content_block_stop": {
        if (!active || data.index !== active.index)
          throw new Error("Invalid block end");
        const block = active.block;
        if (block.type === "tool_use") {
          if (active.json) block.input = object(JSON.parse(active.json));
          yield {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          };
        }
        if (block.type === "hosted_search") {
          const native = block.payload;
          if (native.type === "web_search_tool_result") {
            if (!Array.isArray(native.content))
              throw new Error("Hosted search failed");
            searchCalls++;
            for (const value of native.content) {
              const result = object(value);
              if (
                result.type === "web_search_result" &&
                typeof result.url === "string" &&
                /^https?:\/\//.test(result.url)
              )
                sources.push({
                  url: result.url,
                  title:
                    typeof result.title === "string"
                      ? result.title
                      : result.url,
                  ...(typeof result.page_age === "string"
                    ? { pageAge: result.page_age }
                    : {}),
                });
            }
          }
        } else blocks.push(block);
        nextIndex++;
        active = undefined;
        break;
      }
      case "message_delta": {
        if (!started || stopReason) throw new Error("Invalid message delta");
        const reason = string(object(data.delta).stop_reason);
        if (active) {
          // Only an output-limit cut may leave a block open.
          if (reason !== "max_tokens") throw new Error("Invalid message delta");
          // Keep the text written so far; tool_use, hosted search and reasoning
          // (signature may be incomplete) are dropped without emitting events.
          if (active.block.type === "text") blocks.push(active.block);
          active = undefined;
        }
        stopReason = [
          "end_turn",
          "tool_use",
          "max_tokens",
          "refusal",
          "compaction",
        ].includes(reason)
          ? (reason as StopReason)
          : "other";
        counts = usage(data.usage, counts);
        break;
      }
      case "message_stop": {
        if (!started || active || !stopReason)
          throw new Error("Incomplete Claude message");
        yield {
          type: "message_done",
          message: {
            role: "assistant",
            content: blocks,
            meta: {
              provider: "claude",
              model,
              usage: counts,
              ...(sources.length ? { sources } : {}),
              ...(searchCalls ? { webSearch: { calls: searchCalls } } : {}),
            },
          },
          stopReason,
          usage: counts,
        };
        return;
      }
      case "error": {
        const kind = object(data.error).type;
        if (kind === "rate_limit_error") {
          yield {
            type: "rate_limited",
            ...claudeRateLimit(response.headers, Date.now()),
          };
          return;
        }
        yield {
          type: "error",
          error: {
            kind:
              kind === "authentication_error" ? "authentication" : "transport",
            message: "Claude stream returned an error",
            retryable: kind === "overloaded_error" || kind === "api_error",
          },
        };
        return;
      }
      // Ping and future event types do not modify message state.
    }
  }
  throw new Error("Claude stream ended before message_stop");
}
