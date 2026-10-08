import {
  communicationText,
  type WorkflowCommunication,
  type CommunicationText,
} from "./communication.js";
export const publicActors = {
  llm: "LLM",
  tool: "ツール",
  harness: "ハーネス",
  official: "公式基盤",
};
export const publicKinds = {
  start: "開始",
  response: "応答",
  tool_request: "ツール要求",
  tool_result: "ツール結果",
  approval: "承認判断",
  end: "終了",
};

export interface PublicEvent {
  actor: "llm" | "tool" | "harness" | "official";
  kind:
    "start" | "response" | "tool_request" | "tool_result" | "approval" | "end";
  itemId?: string;
  parentId?: string | null;
  model?: string;
  name?: string;
  status?: string;
  body?: CommunicationText;
  sequence?: number;
  at?: string;
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const id = (v: unknown) =>
  typeof v === "string" && /^[\w.:-]{1,128}$/.test(v) ? v : undefined;
const body = (v: unknown) =>
  v === undefined ? {} : { body: communicationText(v, 4000) };

/** Select public content only; never retain raw messages, thinking or account events. */
export function claudePublicEvents(raw: unknown): PublicEvent[] {
  const e = object(raw),
    m = object(e.message);
  const parentId =
    e.parent_tool_use_id === null ? null : id(e.parent_tool_use_id);
  if (e.type === "result")
    return [
      {
        actor: "official",
        kind: "end",
        status:
          e.subtype === "success" && e.is_error !== true
            ? "completed"
            : "failed",
      },
    ];
  if (e.type !== "assistant" && e.type !== "user") return [];
  if (!Array.isArray(m.content)) return [];
  return m.content.flatMap((rawBlock): PublicEvent[] => {
    const b = object(rawBlock);
    if (
      e.type === "assistant" &&
      b.type === "text" &&
      typeof b.text === "string"
    )
      return [
        {
          actor: "llm",
          kind: "response",
          itemId: id(m.id),
          parentId,
          model: id(m.model),
          ...body(b.text),
        },
      ];
    if (e.type === "assistant" && b.type === "tool_use")
      return [
        {
          actor: "llm",
          kind: "tool_request",
          itemId: id(b.id),
          parentId,
          name: id(b.name),
          ...body(b.input),
        },
      ];
    if (e.type === "user" && b.type === "tool_result")
      return [
        {
          actor: "tool",
          kind: "tool_result",
          itemId: id(b.tool_use_id),
          parentId,
          status: b.is_error === true ? "failed" : "completed",
          ...body(b.content),
        },
      ];
    return [];
  });
}
export function codexPublicEvents(
  method: string,
  params: Record<string, unknown>,
): PublicEvent[] {
  if (method === "turn/started" || method === "turn/completed") {
    const turn = object(params.turn);
    const items =
      method === "turn/completed" && Array.isArray(turn.items)
        ? turn.items.flatMap((item) =>
            codexPublicEvents("item/completed", { item }),
          )
        : [];
    return [
      ...items,
      {
        actor: "official",
        kind: method === "turn/started" ? "start" : "end",
        itemId: id(turn.id),
        status: ["completed", "failed", "interrupted"].includes(
          String(turn.status),
        )
          ? String(turn.status)
          : undefined,
      },
    ];
  }
  if (method !== "item/started" && method !== "item/completed") return [];
  const item = object(params.item),
    itemId = id(item.id),
    done = method === "item/completed";
  if (!itemId) return [];
  if (["analysis", "reasoning", "thinking"].includes(String(item.phase)))
    return [];
  if (item.type === "agentMessage")
    return [
      {
        actor: "llm",
        kind: done ? "response" : "start",
        itemId,
        ...(done ? body(item.text) : {}),
      },
    ];
  if (item.type !== "commandExecution" && item.type !== "fileChange") return [];
  return [
    {
      actor: done ? "tool" : "llm",
      kind: done ? "tool_result" : "tool_request",
      itemId,
      name: String(item.type),
      status: done
        ? ["completed", "failed", "declined", "interrupted"].includes(
            String(item.status),
          )
          ? String(item.status)
          : "unknown"
        : undefined,
      ...body(
        done
          ? item.type === "commandExecution"
            ? {
                exitCode: item.exitCode ?? "未提供",
                output: item.aggregatedOutput ?? "未提供",
              }
            : item.changes
          : item.type === "commandExecution"
            ? { command: item.command, cwd: item.cwd }
            : item.changes,
      ),
    },
  ];
}
/** Arrival order, bounded content and duplicate native notifications. No model replay. */
export function publicEventRecorder(communication: WorkflowCommunication) {
  communication.events = [];
  const seen = new Map<string, PublicEvent>();
  let bytes = 0;
  return (event: PublicEvent): boolean => {
    const key = JSON.stringify([
      event.actor,
      event.kind,
      event.itemId,
      event.kind === "tool_result" || event.kind === "tool_request"
        ? undefined
        : event.parentId,
      event.status,
      event.kind === "tool_result" || event.kind === "tool_request"
        ? undefined
        : event.body,
    ]);
    const previous = event.itemId ? seen.get(key) : undefined;
    if (previous) {
      // A hook may omit the parent that the later SDK message explicitly reports.
      if (previous.parentId !== undefined || event.parentId === undefined)
        return false;
      const enriched = { ...previous, parentId: event.parentId };
      const delta =
        new TextEncoder().encode(JSON.stringify(enriched)).length -
        new TextEncoder().encode(JSON.stringify(previous)).length;
      if (bytes + delta > 64_000) {
        if (communication.eventsOmitted) return false;
        communication.eventsOmitted = true;
      } else {
        previous.parentId = event.parentId;
        bytes += delta;
      }
      return true;
    }
    const saved = {
      ...event,
      sequence: communication.events!.length + 1,
      at: new Date().toISOString(),
    };
    const size = new TextEncoder().encode(JSON.stringify(saved)).length;
    if (communication.events!.length >= 128 || bytes + size > 64_000) {
      if (communication.eventsOmitted) return false;
      communication.eventsOmitted = true;
      return true;
    }
    if (event.itemId) seen.set(key, saved);
    bytes += size;
    communication.events!.push(saved);
    return true;
  };
}
