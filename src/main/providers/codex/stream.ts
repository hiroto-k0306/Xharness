import {
  type ContentBlock,
  type Usage,
  type WebSource,
} from "../../core/types.js";
import { type ProviderEvent, type StopReason } from "../provider.js";
import { readSse } from "../sse.js";

type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid response object");
  return value as Obj;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid response string");
  return value;
}
export function codexOutput(items: unknown[]): ContentBlock[] {
  return items.flatMap((value): ContentBlock[] => {
    const item = object(value);
    switch (item.type) {
      case "web_search_call":
        return [];
      case "reasoning":
        return [
          {
            type: "reasoning",
            provider: "codex",
            payload: structuredClone(item),
          },
        ];
      case "function_call":
        return [
          {
            type: "tool_use",
            id: text(item.call_id),
            name: text(item.name),
            input: object(JSON.parse(text(item.arguments))),
          },
        ];
      case "message": {
        if (!Array.isArray(item.content))
          throw new Error("Invalid message content");
        return item.content.map((value): ContentBlock => {
          const part = object(value);
          if (part.type === "output_text")
            return { type: "text", text: text(part.text) };
          if (part.type === "refusal")
            return { type: "text", text: text(part.refusal) };
          throw new Error("Unsupported response content");
        });
      }
      default:
        throw new Error("Unsupported response item");
    }
  });
}
function usage(value: unknown): Usage {
  const native = object(value);
  const count = (v: unknown) => {
    if (!Number.isSafeInteger(v) || (v as number) < 0)
      throw new Error("Invalid token count");
    return v as number;
  };
  return {
    inputTokens: count(native.input_tokens),
    outputTokens: count(native.output_tokens),
    ...(native.input_tokens_details
      ? {
          cacheReadTokens: count(
            object(native.input_tokens_details).cached_tokens,
          ),
        }
      : {}),
  };
}

export async function* decodeCodexStream(
  response: Response,
): AsyncGenerator<ProviderEvent> {
  const calls = new Set<string>();
  const items = new Map<number, Obj>();
  for await (const event of readSse(response)) {
    if (event.data === "[DONE]") continue;
    const data = object(JSON.parse(event.data));
    switch (data.type) {
      case "response.output_text.delta":
        yield { type: "text_delta", text: text(data.delta) };
        break;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        yield { type: "reasoning_delta", text: text(data.delta) };
        break;
      case "response.output_item.done": {
        const item = object(data.item);
        if (
          !Number.isSafeInteger(data.output_index) ||
          (data.output_index as number) < 0 ||
          items.has(data.output_index as number)
        )
          throw new Error("Invalid output item sequence");
        items.set(data.output_index as number, item);
        if (item.type === "function_call") {
          const block = codexOutput([item])[0]!;
          if (block.type !== "tool_use" || calls.has(block.id))
            throw new Error("Duplicate function call");
          calls.add(block.id);
          yield {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          };
        }
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const native = object(data.response);
        if (!Array.isArray(native.output))
          throw new Error("Missing response output");
        // Recorded Codex completed envelopes have output: []; the done items
        // carry the actual message and encrypted reasoning.
        const output = native.output.length
          ? native.output
          : [...items].sort(([a], [b]) => a - b).map(([, item]) => item);
        const content = codexOutput(output);
        const searchCalls = output.filter((value) => {
          const item = object(value);
          return item.type === "web_search_call" && item.status === "completed";
        }).length;
        const sources: WebSource[] = output.flatMap((value) => {
          const item = object(value);
          if (item.type !== "message" || !Array.isArray(item.content))
            return [];
          return item.content.flatMap((value) => {
            const part = object(value);
            if (!Array.isArray(part.annotations)) return [];
            return part.annotations.flatMap((value) => {
              const citation = object(value);
              return citation.type === "url_citation" &&
                typeof citation.url === "string" &&
                /^https?:\/\//.test(citation.url)
                ? [
                    {
                      url: citation.url,
                      title:
                        typeof citation.title === "string"
                          ? citation.title
                          : citation.url,
                    },
                  ]
                : [];
            });
          });
        });
        const counts = usage(native.usage);
        const pending = content.filter((b) => b.type === "tool_use");
        if (new Set(pending.map((b) => b.id)).size !== pending.length)
          throw new Error("Duplicate function call");
        for (const call of pending)
          if (!calls.has(call.id))
            yield {
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: call.input,
            };
        const refused = output.some(
          (i) =>
            object(i).type === "message" &&
            (object(i).content as unknown[]).some(
              (c) => object(c).type === "refusal",
            ),
        );
        const stopReason: StopReason =
          data.type === "response.incomplete"
            ? object(native.incomplete_details).reason === "max_output_tokens"
              ? "max_tokens"
              : "other"
            : pending.length
              ? "tool_use"
              : refused
                ? "refusal"
                : "end_turn";
        yield {
          type: "message_done",
          message: {
            role: "assistant",
            content,
            meta: {
              provider: "codex",
              model: text(native.model),
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
      case "response.failed":
      case "error": {
        const envelope = data.type === "response.failed" ? data.response : data;
        const failure =
          envelope && typeof envelope === "object" && !Array.isArray(envelope)
            ? (envelope as Obj).error
            : undefined;
        // 実測済みの過負荷だけを再試行する。生の本文・ヘッダは外へ渡さない。
        const overloaded =
          !!failure &&
          typeof failure === "object" &&
          !Array.isArray(failure) &&
          (failure as Obj).type === "service_unavailable_error" &&
          (failure as Obj).code === "server_is_overloaded";
        yield {
          type: "error",
          error: {
            kind: overloaded ? "transport" : "protocol",
            message: overloaded
              ? "Codex側が一時的に混雑しています"
              : "Codexストリームで未分類のエラーが発生しました",
            retryable: overloaded,
          },
        };
        return;
      }
    }
  }
  throw new Error("Codex stream ended before completion");
}
