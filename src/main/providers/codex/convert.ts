import { createHash } from "node:crypto";
import { type ContentBlock, type Message } from "../../core/types.js";
import {
  catalogEffort,
  type CatalogModel,
} from "../../config/model-catalog.js";
import { type ProviderRequest } from "../provider.js";

type NativeItem = Record<string, unknown>;
export function codexCallId(id: string): string {
  return id.startsWith("call_")
    ? id
    : "call_" + createHash("sha256").update(id).digest("hex").slice(0, 24);
}
function resultText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (b.type !== "text")
        throw new Error("Unsupported function result content");
      return b.text;
    })
    .join("\n");
}

export function toCodexInput(messages: readonly Message[]): NativeItem[] {
  const input: NativeItem[] = [];
  for (const message of messages) {
    let content: NativeItem[] = [];
    const flush = () => {
      if (content.length)
        input.push({ type: "message", role: message.role, content });
      content = [];
    };
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          content.push({
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: block.text,
          });
          break;
        case "image":
          if (message.role !== "user")
            throw new Error("Unsupported assistant image");
          content.push({
            type: "input_image",
            image_url: `data:${block.mediaType};base64,${block.data}`,
          });
          break;
        case "tool_use":
          flush();
          input.push({
            type: "function_call",
            call_id: codexCallId(block.id),
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
          break;
        case "tool_result":
          flush();
          input.push({
            type: "function_call_output",
            call_id: codexCallId(block.toolUseId),
            output: resultText(block.content),
          });
          break;
        case "reasoning":
          if (block.provider !== "codex") break;
          flush();
          if (
            !block.payload ||
            typeof block.payload !== "object" ||
            !("type" in block.payload) ||
            block.payload.type !== "reasoning"
          )
            throw new Error("Invalid Codex reasoning item");
          input.push(structuredClone(block.payload) as NativeItem);
          break;
      }
    }
    flush();
  }
  return input;
}

export function toCodexRequest(
  request: ProviderRequest,
  catalog: readonly CatalogModel[],
) {
  const model = catalog.find(
    (m) => m.provider === "codex" && m.id === request.model && m.enabled,
  );
  if (!model || !request.messages.length)
    throw new Error("Unsupported Codex model or empty history");
  return {
    model: request.model,
    instructions: request.system,
    input: toCodexInput(request.messages),
    tools: [
      ...request.tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
      ...(request.webSearch
        ? [
            {
              type: "web_search",
              external_web_access: request.webSearch.mode === "live",
            },
          ]
        : []),
    ],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: catalogEffort(model, request.reasoning?.effort) },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  };
}
