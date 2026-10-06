import { type ContentBlock } from "../../core/types.js";
import { type ProviderRequest } from "../provider.js";
import { catalogModel, sendsEffort } from "../../config/catalog.js";
import { createHash } from "node:crypto";

export const claudeIdentity =
  "You are Claude Code, Anthropic's official CLI for Claude.";
export const defaultMaxTokens = 32000;
type NativeBlock = Record<string, unknown>;
function callId(id: string) {
  return id.startsWith("call_")
    ? "toolu_" + createHash("sha256").update(id).digest("hex").slice(0, 24)
    : id;
}
function cacheLast(blocks: NativeBlock[]) {
  const block = blocks.findLast(
    (b) =>
      !["thinking", "redacted_thinking", "compaction"].includes(String(b.type)),
  );
  if (block) block.cache_control = { type: "ephemeral" };
}

function convertBlocks(blocks: ContentBlock[]): NativeBlock[] {
  return blocks.flatMap((block): NativeBlock[] => {
    switch (block.type) {
      case "text":
        return [{ type: "text", text: block.text }];
      case "image":
        return [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: block.mediaType,
              data: block.data,
            },
          },
        ];
      case "tool_use":
        return [
          {
            type: "tool_use",
            id: callId(block.id),
            name: block.name,
            input: block.input,
          },
        ];
      case "tool_result":
        return [
          {
            type: "tool_result",
            tool_use_id: callId(block.toolUseId),
            content:
              typeof block.content === "string"
                ? block.content
                : convertBlocks(block.content),
            ...(block.isError === undefined ? {} : { is_error: block.isError }),
          },
        ];
      case "reasoning": {
        if (block.provider !== "claude") return [];
        const native = block.payload;
        if (
          !native ||
          typeof native !== "object" ||
          !("type" in native) ||
          !["thinking", "redacted_thinking"].includes(String(native.type))
        )
          throw new Error("Invalid Claude reasoning block");
        return [{ ...native }];
      }
      case "compaction": {
        const native = block.payload as NativeBlock;
        if (
          native?.type !== "compaction" ||
          typeof native.content !== "string" ||
          typeof native.signature !== "string"
        )
          throw new Error("Invalid signed compaction block");
        return [structuredClone(native)];
      }
    }
  });
}

export function toClaudeRequest(request: ProviderRequest) {
  const maxTokens = request.maxOutputTokens ?? defaultMaxTokens;
  if (
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    !request.messages.length
  )
    throw new Error("Invalid Claude request");
  // Capabilities come from the catalog: models listing efforts receive one;
  // enabled catalog models without efforts accept and drop it (e.g. Haiku).
  const catalogEntry = catalogModel(request.model);
  const supportsEffort = !!catalogEntry && sendsEffort(catalogEntry);
  const effort = request.reasoning?.effort ?? "high";
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort))
    throw new Error("Invalid effort");
  if (
    request.reasoning &&
    !supportsEffort &&
    !(catalogEntry?.enabled && catalogEntry.provider === "claude")
  )
    throw new Error("Unsupported model effort");
  const system: NativeBlock[] = [
    { type: "text", text: claudeIdentity },
    ...(request.system ? [{ type: "text", text: request.system }] : []),
  ];
  cacheLast(system);
  const messages = request.messages
    .map((message) => {
      const content = convertBlocks(message.content);
      return { role: message.role, content };
    })
    .filter((message) => message.content.length);
  if (!messages.length)
    throw new Error("Empty Claude history after provider conversion");
  cacheLast(messages.at(-1)!.content);
  const tools = request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
  cacheLast(tools);
  const hosted = request.webSearch
    ? [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }]
    : [];
  return {
    model: request.model,
    max_tokens: maxTokens,
    stream: true,
    system,
    messages,
    ...(request.compaction ? { compaction: request.compaction } : {}),
    // Omit thinking entirely: Opus/Sonnet retain their native adaptive behavior.
    ...(supportsEffort ? { output_config: { effort } } : {}),
    ...(tools.length || hosted.length
      ? { tools: [...tools, ...hosted], tool_choice: { type: "auto" } }
      : {}),
  };
}
