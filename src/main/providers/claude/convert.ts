import { type ContentBlock } from "../../core/types.js";
import { type ProviderRequest } from "../provider.js";

export const claudeIdentity =
  "You are Claude Code, Anthropic's official CLI for Claude.";
type NativeBlock = Record<string, unknown>;
function cacheLast(blocks: NativeBlock[]) {
  const block = blocks.findLast(
    (b) => !["thinking", "redacted_thinking"].includes(String(b.type)),
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
            id: block.id,
            name: block.name,
            input: block.input,
          },
        ];
      case "tool_result":
        return [
          {
            type: "tool_result",
            tool_use_id: block.toolUseId,
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
    }
  });
}

export function toClaudeRequest(request: ProviderRequest) {
  const maxTokens = request.maxOutputTokens ?? 4096;
  if (
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    !request.messages.length
  )
    throw new Error("Invalid Claude request");
  // Effort support was not tested for Claude in Phase 0; do not silently ignore it.
  if (request.reasoning) throw new Error("Claude effort is not yet verified");
  const system: NativeBlock[] = [
    { type: "text", text: claudeIdentity },
    ...(request.system ? [{ type: "text", text: request.system }] : []),
  ];
  cacheLast(system);
  const messages = request.messages.map((message) => {
    const content = convertBlocks(message.content);
    if (!content.length)
      throw new Error("Empty Claude message after provider conversion");
    return { role: message.role, content };
  });
  cacheLast(messages.at(-1)!.content);
  const tools = request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
  cacheLast(tools);
  return {
    model: request.model,
    max_tokens: maxTokens,
    stream: true,
    system,
    messages,
    ...(tools.length ? { tools } : {}),
  };
}
