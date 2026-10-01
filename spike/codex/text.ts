import { type SseEvent } from "../lib/sse.js";

export function summarizeCodexText(events: SseEvent[]) {
  let text = "";
  let completed = false;
  let failed = false;
  for (const event of events) {
    if (event.data === "[DONE]") continue;
    try {
      const data = JSON.parse(event.data) as {
        type?: string;
        delta?: string;
        response?: { status?: string };
      };
      if (data.type === "response.output_text.delta") text += data.delta ?? "";
      if (data.type === "response.completed")
        completed = data.response?.status === "completed";
      if (
        ["error", "response.failed", "response.incomplete"].includes(
          data.type ?? "",
        )
      )
        failed = true;
    } catch {
      failed = true;
    }
  }
  return {
    text,
    completed,
    failed,
    eventTypes: events.map((event) => event.event),
  };
}
