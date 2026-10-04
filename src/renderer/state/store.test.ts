import { describe, expect, it } from "vitest";
import { type AppState, type UiEvent } from "../../shared/ipc.js";
import { applyEvent, type EventState } from "./store.js";

const app = (over: Partial<AppState> = {}): AppState => ({
  sessions: [],
  workspaces: [],
  currentSessionId: "s1",
  model: "fake",
  effort: "high",
  fake: true,
  version: "0",
  ...over,
});
const run = (
  events: UiEvent[],
  start: EventState = { app: app(), views: {} },
) => events.reduce(applyEvent, start);

describe("applyEvent", () => {
  it("keeps the first user message when new-session IPC events arrive after its reply", () => {
    const s = run([
      { type: "transcript", sessionId: "s1", items: [] },
      { type: "user_message", sessionId: "s1", messageId: "u1", text: "first" },
      { type: "text_delta", sessionId: "s1", messageId: "m1", text: "pong" },
    ]);
    expect(s.views.s1!.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(s.views.s1!.items[0]).toMatchObject({ text: "first" });
  });
  it("accumulates streamed text into one assistant message per messageId", () => {
    const s = run([
      { type: "text_delta", sessionId: "s1", messageId: "m1", text: "he" },
      { type: "text_delta", sessionId: "s1", messageId: "m1", text: "llo" },
      { type: "text_delta", sessionId: "s1", messageId: "m2", text: "next" },
    ]);
    expect(s.views.s1!.items).toEqual([
      { kind: "assistant", id: "m1", text: "hello" },
      { kind: "assistant", id: "m2", text: "next" },
    ]);
  });
  it("tracks a tool call from pending to ok", () => {
    const s = run([
      {
        type: "tool_call",
        sessionId: "s1",
        receiptId: "#0001",
        provider: "claude",
        tool: "Read",
        input: { path: "a" },
      },
      {
        type: "tool_result",
        sessionId: "s1",
        receiptId: "#0001",
        isError: false,
      },
    ]);
    expect(s.views.s1!.items[0]).toMatchObject({
      kind: "tool",
      tool: "Read",
      status: "ok",
    });
  });
  it("puts the full input into the tool card detail", () => {
    const s = run([
      {
        type: "tool_call",
        sessionId: "s1",
        receiptId: "#0001",
        provider: "claude",
        tool: "Bash",
        input: { command: "echo hi\nls" },
      },
      {
        type: "tool_call",
        sessionId: "s1",
        receiptId: "#0002",
        provider: "claude",
        tool: "Read",
        input: { path: "a" },
      },
    ]);
    expect(s.views.s1!.items[0]).toMatchObject({ detail: "echo hi\nls" });
    expect(s.views.s1!.items[1]).toMatchObject({
      detail: JSON.stringify({ path: "a" }, null, 2),
    });
  });
  it("keeps 'denied' when the error result arrives afterwards", () => {
    const s = run([
      {
        type: "tool_call",
        sessionId: "s1",
        receiptId: "#0001",
        provider: "claude",
        tool: "Write",
        input: {},
      },
      {
        type: "permission_request",
        sessionId: "s1",
        requestId: "r",
        receiptId: "#0001",
        tool: "Write",
        summary: "Write {}",
      },
      {
        type: "permission_resolved",
        sessionId: "s1",
        requestId: "r",
        decision: "deny",
      },
      {
        type: "tool_result",
        sessionId: "s1",
        receiptId: "#0001",
        isError: true,
      },
    ]);
    expect(s.views.s1!.items[0]).toMatchObject({ status: "denied" });
    expect(s.views.s1!.pending).toBeUndefined();
  });
  it("sets and clears the pending permission and the active step", () => {
    let s = run([
      { type: "turn", sessionId: "s1", status: "running" },
      { type: "step", sessionId: "s1", step: 4, node: "gate", round: 2 },
      {
        type: "permission_request",
        sessionId: "s1",
        requestId: "r",
        tool: "Bash",
        summary: "Bash x",
      },
    ]);
    expect(s.views.s1).toMatchObject({
      running: true,
      step: { step: 4, round: 2 },
      pending: { requestId: "r" },
    });
    s = applyEvent(s, {
      type: "turn",
      sessionId: "s1",
      status: "idle",
      stopCause: "end_turn",
    });
    expect(s.views.s1).toMatchObject({
      running: false,
      step: undefined,
      pending: undefined,
    });
  });
  it("keeps sessions separate so a background session does not leak into the current one", () => {
    const s = run([
      {
        type: "text_delta",
        sessionId: "bg",
        messageId: "m",
        text: "background",
      },
      { type: "text_delta", sessionId: "s1", messageId: "m", text: "front" },
    ]);
    expect(s.views.bg!.items).toHaveLength(1);
    expect(s.views.s1!.items[0]).toMatchObject({ text: "front" });
  });
  it("replaces the transcript on load and adds a notice on abort and error", () => {
    let s = run([
      {
        type: "transcript",
        sessionId: "s1",
        items: [{ kind: "user", id: "u", text: "old" }],
      },
      { type: "turn", sessionId: "s1", status: "idle", stopCause: "aborted" },
      { type: "error", message: "boom" },
    ]);
    expect(s.views.s1!.items.map((i) => i.kind)).toEqual([
      "user",
      "notice",
      "notice",
    ]);
    s = applyEvent(s, { type: "transcript", sessionId: "s1", items: [] });
    expect(s.views.s1!.items).toEqual([]);
  });
  it("preserves assistant presentation only on explicitly marked report notices", () => {
    const s = run([
      {
        type: "notice",
        sessionId: "s1",
        tone: "dim",
        message: "report",
        presentation: "assistant",
      },
      { type: "notice", sessionId: "s1", tone: "warn", message: "ordinary" },
      { type: "error", sessionId: "s1", message: "failed" },
    ]);
    expect(s.views.s1!.items[0]).toMatchObject({
      kind: "notice",
      text: "report",
      presentation: "assistant",
    });
    expect(s.views.s1!.items[1]).not.toHaveProperty("presentation");
    expect(s.views.s1!.items[2]).toMatchObject({
      kind: "notice",
      tone: "err",
      text: "failed",
    });
    expect(s.views.s1!.items[2]).not.toHaveProperty("presentation");
  });
  it("stores app state and ignores events Phase 2 does not display", () => {
    const next = app({ model: "claude-haiku-4-5" });
    const s = run([
      { type: "state", state: next },
      { type: "usage", provider: "claude", window5h: 0.5 },
      { type: "agent", agentId: "a", name: "x", model: "m", status: "running" },
    ]);
    expect(s.app).toBe(next);
    expect(s.views).toEqual({});
  });
});
