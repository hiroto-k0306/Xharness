export interface SseEvent {
  event: string;
  data: string;
}

export async function* readSse(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body) throw new Error("Response has no readable body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  const line = (text: string): SseEvent | undefined => {
    if (text === "") {
      const result = data.length ? { event, data: data.join("\n") } : undefined;
      event = "message";
      data = [];
      return result;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value || "message";
    if (field === "data") data.push(value);
  };
  const drain = function* (final: boolean): Generator<SseEvent> {
    while (true) {
      const match = /[\r\n]/.exec(buffer);
      if (!match) break;
      const index = match.index;
      if (!final && buffer[index] === "\r" && index === buffer.length - 1)
        break;
      const width =
        buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
      const result = line(buffer.slice(0, index));
      buffer = buffer.slice(index + width);
      if (result) yield result;
    }
  };
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        yield* drain(true);
        // SSE requires a blank line; an unfinished event at EOF is discarded.
        complete = true;
        return;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      yield* drain(false);
    }
  } finally {
    try {
      if (!complete) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
