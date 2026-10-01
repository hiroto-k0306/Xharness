import { type ContentBlock, type Message, type ProviderId } from "./types.js";

/** Only the outgoing view changes; append-only stored history retains opaque blocks. */
export function messagesForProvider(
  messages: readonly Message[],
  provider: ProviderId,
): Message[] {
  const filter = (blocks: ContentBlock[]): ContentBlock[] =>
    blocks.flatMap((b): ContentBlock[] => {
      if (b.type === "reasoning" && b.provider !== provider) return [];
      if (b.type === "tool_result" && Array.isArray(b.content))
        return [{ ...structuredClone(b), content: filter(b.content) }];
      return [structuredClone(b)];
    });
  return messages
    .map((m) => ({ ...structuredClone(m), content: filter(m.content) }))
    .filter((m) => m.content.length);
}
