import { describe, expect, it } from "vitest";
import { COMMAND_CHANNEL, EVENT_CHANNEL, parseCommand } from "./ipc.js";

describe("IPC contract", () => {
  it("accepts only known authentication providers", () => {
    expect(
      parseCommand({
        type: "authenticate",
        provider: "claude",
        command: "unsafe",
      }),
    ).toEqual({ type: "authenticate", provider: "claude" });
    expect(
      parseCommand({ type: "authenticate", provider: "arbitrary" }),
    ).toBeUndefined();
    expect(parseCommand({ type: "refresh_auth" })).toEqual({
      type: "refresh_auth",
    });
  });
  it("uses exactly the two channels from DESIGN §16.4", () => {
    expect([EVENT_CHANNEL, COMMAND_CHANNEL]).toEqual([
      "harness:event",
      "harness:command",
    ]);
  });
  it("accepts well-formed commands", () => {
    expect(parseCommand({ type: "ready" })).toEqual({ type: "ready" });
    expect(parseCommand({ type: "send", sessionId: "s1", text: "hi" })).toEqual(
      {
        type: "send",
        sessionId: "s1",
        text: "hi",
      },
    );
    expect(
      parseCommand({
        type: "permission_response",
        sessionId: "s1",
        requestId: "r1",
        decision: "always",
      }),
    ).toMatchObject({ decision: "always" });
    expect(parseCommand({ type: "new_session", workspaceId: null })).toEqual({
      type: "new_session",
      workspaceId: null,
      readOnly: false,
    });
  });
  it("rejects malformed or unknown input from the renderer", () => {
    for (const bad of [
      undefined,
      null,
      "ready",
      {},
      { type: "exec", command: "calc" },
      { type: "send", sessionId: "s", text: "" },
      { type: "send", sessionId: "s", text: "x".repeat(200_001) },
      { type: "send", sessionId: 1, text: "x" },
      {
        type: "permission_response",
        sessionId: "s",
        requestId: "r",
        decision: "maybe",
      },
      { type: "new_session", workspaceId: 5 },
      { type: "set_model", model: "" },
    ])
      expect(parseCommand(bad)).toBeUndefined();
  });
  it("validates set_model and close_session", () => {
    expect(
      parseCommand({
        type: "set_model",
        sessionId: "s",
        model: "opus",
        effort: "low",
      }),
    ).toEqual({
      type: "set_model",
      sessionId: "s",
      model: "opus",
      effort: "low",
    });
    expect(
      parseCommand({ type: "set_model", sessionId: "s", model: "opus" }),
    ).toMatchObject({
      type: "set_model",
    });
    for (const bad of [
      { type: "set_model", model: "opus" }, // sessionId が無い: 全体へは効かせない
      { type: "set_model", sessionId: "s", model: "opus", effort: "turbo" },
      { type: "close_session" },
    ])
      expect(parseCommand(bad)).toBeUndefined();
    expect(parseCommand({ type: "close_session", sessionId: "s" })).toEqual({
      type: "close_session",
      sessionId: "s",
    });
  });
  it("drops extra fields so nothing unvalidated reaches main", () => {
    const parsed = parseCommand({
      type: "open_session",
      sessionId: "s1",
      path: "C:\\secret",
    });
    expect(parsed).toEqual({ type: "open_session", sessionId: "s1" });
  });
});
