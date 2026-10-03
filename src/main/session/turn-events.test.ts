import { describe, expect, it } from "vitest";
import { type ControllerContext } from "./context.js";
import { TurnEvents, updateQuota, usageEvent } from "./turn-events.js";

describe("TurnEvents text flush before tool_use", () => {
  it("sends buffered text before tool_call with the same messageId", () => {
    const emitted: { type: string; messageId?: string; text?: string }[] = [];
    const ctx = {
      options: {
        provider: { id: "claude" },
        emit: (e: never) => emitted.push(e),
      },
      clean: (s: string) => s,
      sessions: new Map(),
    } as unknown as ControllerContext;
    const session = { id: "s1", model: "x" } as never;
    const rt = { messageSeq: 0, receiptSeq: 0 } as never;
    const te = new TurnEvents(ctx, session, rt);
    te.onEvent({
      type: "text_delta",
      text: "前回までに失敗した 4 ファイルを実行します。",
    } as never);
    te.onEvent({
      type: "tool_use",
      id: "c1",
      name: "bash",
      input: {},
    } as never);
    te.onEvent({ type: "message_done" } as never);
    expect(emitted.map((e) => e.type)).toEqual([
      "text_delta",
      "text_delta",
      "tool_call",
    ]);
    expect(emitted[0]?.text).toBe("前回までに失敗した 4 ");
    expect(emitted[1]?.text).toBe("ファイルを実行します。");
    expect(emitted[0]?.messageId).toBe(emitted[1]?.messageId);
  });
});

describe("usage tracking for Web auto (§22.2)", () => {
  it("keeps the latest value per window and does not drop windows missing from a later event", () => {
    const ctx = { quota: {}, usage: {} } as unknown as ControllerContext;
    updateQuota(ctx, {
      type: "usage",
      provider: "claude",
      windows: [
        { name: "5h", windowMinutes: 300, usedPercent: 10, resetAt: "a" },
        { name: "7d", windowMinutes: 10080, usedPercent: 80, resetAt: "b" },
      ],
    });
    usageEvent(ctx, {
      type: "usage",
      provider: "claude",
      windows: [{ name: "5h", windowMinutes: 300, usedPercent: 20 }],
    });
    expect(ctx.quota).toEqual({ claude: 20 });
    expect(ctx.usage.claude).toEqual([
      { name: "5h", windowMinutes: 300, usedPercent: 20 },
      { name: "7d", windowMinutes: 10080, usedPercent: 80, resetAt: "b" },
    ]);
  });
});
