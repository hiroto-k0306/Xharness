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
  it("normalizes child quota, retains known windows through partial/missing headers, and never invents zero", () => {
    const ctx = { quota: {}, usage: {} } as unknown as ControllerContext;
    expect(usageEvent(ctx, { type: "usage", provider: "codex" })).toMatchObject(
      { window5h: undefined, weekly: undefined },
    );
    const initial = usageEvent(ctx, {
      type: "usage",
      provider: "codex",
      windows: [
        {
          name: "primary",
          windowMinutes: 300,
          usedPercent: 35,
          resetAt: "2026-10-05T00:00:00Z",
        },
        { name: "secondary", windowMinutes: 10080, usedPercent: 70 },
      ],
    });
    expect(initial).toMatchObject({ window5h: 35, weekly: 70 });
    expect(
      usageEvent(ctx, {
        type: "usage",
        provider: "codex",
        windows: [{ name: "secondary", windowMinutes: 10080, usedPercent: 71 }],
      }),
    ).toMatchObject({ window5h: 35, weekly: 71 });
    expect(
      usageEvent(ctx, { type: "usage", provider: "codex", windows: [] }),
    ).toMatchObject({ window5h: 35, weekly: 71 });
    expect(ctx.quota.codex).toBe(35);
    expect(
      usageEvent(ctx, { type: "usage", provider: "codex", window5h: 0 }),
    ).toMatchObject({ window5h: 0, weekly: 71 });
  });
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
      { name: "5h", windowMinutes: 300, usedPercent: 20, resetAt: "a" },
      { name: "7d", windowMinutes: 10080, usedPercent: 80, resetAt: "b" },
    ]);
  });
});
