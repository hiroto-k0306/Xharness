import { type ContentBlock, type Usage } from "../../core/types.js";
import { type ProviderEvent, type StopReason } from "../provider.js";
import { readSse } from "./sse.js";
import { claudeRateLimit } from "./rate-limit.js";

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
  return result;
}

export async function* decodeClaudeStream(
  response: Response,
): AsyncGenerator<ProviderEvent> {
  const blocks: ContentBlock[] = [];
  let active: { index: number; block: ContentBlock; json: string } | undefined;
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
        if (!started || active || stopReason || data.index !== blocks.length)
          throw new Error("Invalid block sequence");
        const native = object(data.content_block);
        let block: ContentBlock;
        switch (native.type) {
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
        active = { index: blocks.length, block, json: "" };
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
          block.type === "tool_use"
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
        blocks.push(block);
        active = undefined;
        break;
      }
      case "message_delta": {
        if (!started || active || stopReason)
          throw new Error("Invalid message delta");
        const reason = string(object(data.delta).stop_reason);
        stopReason = ["end_turn", "tool_use", "max_tokens", "refusal"].includes(
          reason,
        )
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
            meta: { provider: "claude", model, usage: counts },
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
