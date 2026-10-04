import { expect, it, vi } from "vitest";
import { applyEvent, type EventState } from "../../renderer/state/store.js";
import { parseCommand, type UiEvent } from "../../shared/ipc.js";
import { runTurn } from "../core/loop.js";
import { type Provider, type ProviderEvent } from "../providers/provider.js";
import { type ControllerContext, type Runtime } from "./context.js";
import { TurnEvents } from "./turn-events.js";

function setup() {
  let state: EventState = {
    app: null,
    views: {
      s1: {
        running: true,
        items: [
          { kind: "user", id: "user", text: "start" },
          { kind: "assistant", id: "s1-m0", text: "accepted history" },
          {
            kind: "tool",
            id: "old",
            tool: "Read",
            summary: "old",
            status: "ok",
          },
        ],
      },
      s2: {
        running: false,
        items: [{ kind: "assistant", id: "s1-m1", text: "other session" }],
      },
    },
  };
  const emitted: UiEvent[] = [];
  const ctx = {
    options: {
      provider: { id: "codex" },
      emit: (event: UiEvent) => {
        emitted.push(event);
        state = applyEvent(state, event);
      },
    },
    clean: (s: string) => s,
    sessions: new Map(),
    receipts: { append: vi.fn(async () => undefined) },
  } as unknown as ControllerContext;
  const rt = { messageSeq: 1, receiptSeq: 0 } as Runtime;
  const events = new TurnEvents(
    ctx,
    { id: "s1", model: "codex:luna" } as never,
    rt,
  );
  return { events, emitted, state: () => state };
}
function done(tool = false): ProviderEvent {
  return {
    type: "message_done",
    message: {
      role: "assistant",
      content: tool
        ? [
            { type: "text", text: "successful " },
            { type: "tool_use", id: "call", name: "Write", input: {} },
          ]
        : [{ type: "text", text: "done " }],
    },
    stopReason: tool ? "tool_use" : "end_turn",
    usage: { inputTokens: 10, outputTokens: 2 },
  };
}
const failure: ProviderEvent = {
  type: "error",
  error: { kind: "transport", message: "overloaded", retryable: true },
};

it("rolls back failed text/cards and pairs the retry result with the new card", async () => {
  const { events, emitted, state } = setup();
  let attempts = 0;
  const provider: Provider = {
    id: "codex",
    models: () => [],
    async *stream() {
      switch (attempts++) {
        case 0:
          yield { type: "text_delta", text: "failed partial " };
          yield { type: "tool_use", id: "call", name: "Write", input: {} };
          yield { type: "text_delta", text: "discarded-buffer" };
          yield failure;
          return;
        case 1:
          expect(events.receiptByCall.has("call")).toBe(false);
          expect(
            state().views.s1!.items.some(
              (i) => i.kind === "tool" && i.status === "pending",
            ),
          ).toBe(false);
          yield { type: "text_delta", text: "successful " };
          yield { type: "tool_use", id: "call", name: "Write", input: {} };
          yield done(true);
          return;
        default:
          yield { type: "text_delta", text: "done " };
          yield done();
      }
    },
  };
  const execute = vi.fn(async () => ({ content: "ok" }));
  const result = await runTurn(
    {
      provider,
      model: "test",
      system: "system",
      messages: [{ role: "user", content: [{ type: "text", text: "start" }] }],
      tools: new Map([
        [
          "Write",
          {
            spec: {
              name: "Write",
              description: "synthetic mutation",
              inputSchema: { type: "object" },
            },
            readOnly: false,
            validate: async () => undefined,
            execute,
          },
        ],
      ]),
      permission: async () => true,
      sleep: async () => undefined,
      onEvent: events.onEvent,
    },
    new AbortController().signal,
  );
  await Promise.all(events.receiptWrites);
  expect(result.stopCause).toBe("end_turn");
  expect(execute).toHaveBeenCalledTimes(1);
  const cards = emitted.filter((e) => e.type === "tool_call");
  const toolResult = emitted.find((e) => e.type === "tool_result");
  expect(cards).toHaveLength(2);
  expect(toolResult?.receiptId).toBe(cards[1]!.receiptId);
  expect(state().views.s1!.items.filter((i) => i.kind === "tool")).toEqual([
    expect.objectContaining({ id: "old", status: "ok" }),
    expect.objectContaining({ id: cards[1]!.receiptId, status: "ok" }),
  ]);
  expect(
    state()
      .views.s1!.items.filter((i) => i.kind === "assistant")
      .map((i) => i.text),
  ).toEqual(["accepted history", "successful ", "done "]);
  expect(state().views.s2!.items).toEqual([
    { kind: "assistant", id: "s1-m1", text: "other session" },
  ]);
  expect(state().views.s1!.running).toBe(true);
  expect(
    parseCommand({
      type: "attempt_discarded",
      sessionId: "s1",
      messageId: "s1-m1",
      receiptIds: [],
    }),
  ).toBeUndefined();
});

it("also discards uncommitted output on terminal failure while keeping history and the error notice", async () => {
  const { events, state } = setup();
  let attempts = 0;
  const provider: Provider = {
    id: "codex",
    models: () => [],
    async *stream() {
      attempts++;
      yield { type: "text_delta", text: "unfinished " };
      yield { type: "tool_use", id: "call", name: "Write", input: {} };
      yield {
        type: "error",
        error: {
          kind: "protocol",
          message: "terminal failure",
          retryable: false,
        },
      };
    },
  };
  const messages = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "start" }],
    },
  ];
  const result = await runTurn(
    {
      provider,
      model: "test",
      system: "system",
      messages,
      tools: new Map(),
      permission: async () => true,
      onEvent: events.onEvent,
    },
    new AbortController().signal,
  );
  await Promise.all(events.receiptWrites);
  expect(result.stopCause).toBe("protocol");
  expect(attempts).toBe(1);
  expect(result.messages).toEqual(messages);
  expect(events.receiptByCall.has("call")).toBe(false);
  const finished = applyEvent(state(), {
    type: "turn",
    sessionId: "s1",
    status: "idle",
    stopCause: result.stopCause,
  });
  expect(finished.views.s1!.running).toBe(false);
  expect(
    finished.views
      .s1!.items.filter((i) => i.kind === "assistant")
      .map((i) => i.text),
  ).toEqual(["accepted history"]);
  expect(finished.views.s1!.items.filter((i) => i.kind === "tool")).toEqual([
    expect.objectContaining({ id: "old", status: "ok" }),
  ]);
  expect(finished.views.s1!.items).toContainEqual(
    expect.objectContaining({
      kind: "notice",
      tone: "err",
      text: "terminal failure",
    }),
  );
  expect(finished.views.s1!.receipts?.length).toBeGreaterThan(0);
});

it.each([failure, { type: "rate_limited", retryAfterSec: 0 } as ProviderEvent])(
  "discards buffered-only text before retry/fallback: %j",
  (failed) => {
    const { events, state } = setup();
    events.onEvent({ type: "text_delta", text: "discarded-buffer" });
    events.onEvent(failed);
    events.onEvent({ type: "text_delta", text: "successful " });
    events.flush();
    expect(
      state()
        .views.s1!.items.filter((i) => i.kind === "assistant")
        .map((i) => i.text),
    ).toEqual(["accepted history", "successful "]);
  },
);
