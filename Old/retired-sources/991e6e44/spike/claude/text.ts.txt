import { inspectHeaders } from "../lib/headers.js";
import { maskSecrets } from "../lib/mask.js";
import { record } from "../lib/record.js";
import { readSse, type SseEvent } from "../lib/sse.js";
import { reserveRequest } from "../lib/budget.js";

export type SystemMode = "none" | "identity" | "custom";
export type TextModel = "claude-haiku-4-5-20251001" | "claude-opus-5-5";

export function summarizeText(events: SseEvent[]) {
  let text = "";
  let stopReason: unknown;
  let streamError = false;
  for (const event of events) {
    if (event.event === "error") streamError = true;
    try {
      const data = JSON.parse(event.data) as {
        delta?: { type?: string; text?: string; stop_reason?: unknown };
      };
      if (data.delta?.type === "text_delta") text += data.delta.text ?? "";
      if (event.event === "message_delta") stopReason = data.delta?.stop_reason;
    } catch {
      streamError = true;
    }
  }
  return {
    text,
    stopReason,
    eventTypes: events.map((event) => event.event),
    complete:
      events.some((event) => event.event === "message_stop") && !streamError,
  };
}

export async function probeText(
  accessToken: string,
  model: TextModel,
  mode: SystemMode,
  options: { root?: string; fetcher?: typeof fetch } = {},
) {
  const system =
    mode === "none"
      ? undefined
      : [
          {
            type: "text",
            text: "You are Claude Code, Anthropic's official CLI for Claude.",
          },
          ...(mode === "custom"
            ? [{ type: "text", text: "Answer in Japanese." }]
            : []),
        ];
  const body = {
    model,
    max_tokens: 64,
    stream: true,
    messages: [{ role: "user", content: "Reply with the single word: pong" }],
    ...(system ? { system } : {}),
  };
  const headers = new Headers({
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
  });
  const name = `c2-${model === "claude-opus-5-5" ? "opus" : "haiku"}-${mode}`;
  const requestNumber = await reserveRequest("claude", name, options.root);
  let response: Response | undefined;
  const events: SseEvent[] = [];
  let responseBody: unknown;
  let transportFailure = false;
  try {
    response = await (options.fetcher ?? fetch)(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      for await (const event of readSse(response)) events.push(event);
    } else responseBody = await response.text();
  } catch {
    // Transport errors can contain request details; persist no raw exception.
    transportFailure = true;
    responseBody = { error: { type: "transport_error" } };
  }
  const paths = await record(
    "claude",
    name,
    {
      requestHeaders: headers,
      requestBody: body,
      responseHeaders: response?.headers ?? new Headers(),
      status: response?.status ?? 0,
      events,
      body: responseBody,
    },
    { root: options.root, secrets: [accessToken] },
  );
  const summary = summarizeText(events);
  const success =
    response?.ok === true &&
    summary.complete &&
    !transportFailure &&
    summary.stopReason === "end_turn" &&
    summary.text.trim() === "pong";
  return {
    success,
    report: maskSecrets(
      {
        model,
        mode,
        requestNumber,
        status: response?.status ?? 0,
        transportFailure,
        ...summary,
        usageHeaders: inspectHeaders(response?.headers ?? new Headers(), [
          accessToken,
        ]).usage,
        errorBody: responseBody,
        paths,
        success,
      },
      [accessToken],
    ),
  };
}
