import { type Message } from "../core/types.js";
import { type TranscriptItem } from "../../shared/ipc.js";
import { summarizeInput } from "../../shared/summary.js";
import { parseTodos } from "../../shared/todos.js";

/** 保存済み履歴から画面用の項目を作る(再開時)。 */
export function itemsFromMessages(messages: Message[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
  messages.forEach((message, mi) => {
    if (
      message.role === "user" &&
      !message.content.some(
        (b) => b.type === "text" && !b.text.startsWith("[MCP update]"),
      ) &&
      message.content.some((b) => b.type === "image")
    )
      items.push({
        kind: "user",
        id: `h${mi}-image`,
        text: "",
        images: message.content.flatMap((b) =>
          b.type === "image" ? [{ mediaType: b.mediaType, data: b.data }] : [],
        ),
      });
    for (const [bi, block] of message.content.entries()) {
      const id = `h${mi}-${bi}`;
      if (block.type === "text" && message.role === "user") {
        // MCP の一覧の変化の注記はモデル向け。再開時の画面にも出さない(§25.4)
        if (!block.text.startsWith("[MCP update]"))
          items.push({
            kind: "user",
            id,
            text: block.text,
            ...(message.content.some((b) => b.type === "image")
              ? {
                  images: message.content.flatMap((b) =>
                    b.type === "image"
                      ? [{ mediaType: b.mediaType, data: b.data }]
                      : [],
                  ),
                }
              : {}),
          });
      } else if (block.type === "text")
        items.push({ kind: "assistant", id, text: block.text });
      else if (block.type === "tool_use") {
        const item: Extract<TranscriptItem, { kind: "tool" }> = {
          kind: "tool",
          id,
          tool: block.name,
          summary: summarizeInput(block.name, block.input),
          todos:
            block.name === "TodoWrite" ? parseTodos(block.input) : undefined,
          status: "pending",
        };
        tools.set(block.id, item);
        items.push(item);
      } else if (block.type === "tool_result") {
        const item = tools.get(block.toolUseId);
        if (item)
          item.status = block.isError
            ? block.content === "Permission denied by user"
              ? "denied"
              : "error"
            : "ok";
      }
    }
  });
  return items;
}
