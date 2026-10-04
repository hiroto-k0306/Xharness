import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionController } from "./controller.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { type UiEvent } from "../../shared/ipc.js";

it("child usage passes through the same normalization/cache as main usage", async () => {
  class ChildQuota extends FakeProvider {
    override async *stream(...args: Parameters<FakeProvider["stream"]>) {
      yield {
        type: "usage" as const,
        provider: "codex" as const,
        windows: [
          { name: "primary", windowMinutes: 300, usedPercent: 42 },
          { name: "secondary", windowMinutes: 10080, usedPercent: 76 },
        ],
      };
      yield { type: "usage" as const, provider: "codex" as const, windows: [] };
      yield* super.stream(...args);
    }
  }
  const main = new FakeProvider({
    script: [
      {
        type: "message",
        stopReason: "tool_use",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "child",
              name: "Task",
              input: {
                description: "inspect",
                agent: "reviewer",
                model: "codex:sol",
                prompt: "inspect only",
              },
            },
          ],
        },
      },
      {
        type: "message",
        stopReason: "end_turn",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      },
    ],
  });
  const events: UiEvent[] = [];
  const controller = new SessionController({
    home: await mkdtemp(join(tmpdir(), "xh-child-usage-")),
    provider: main,
    providers: [main, new ChildQuota({ provider: "codex" })],
    model: "claude-opus-5-5",
    phase4: true,
    fake: true,
    version: "test",
    host: { pickFolder: async () => undefined },
    emit: (event) => events.push(event),
  });
  try {
    await controller.init();
    const created = await controller.handle({
      type: "new_session",
      workspaceId: null,
    });
    if (!created.ok || !created.sessionId) throw new Error("session missing");
    await controller.handle({
      type: "send",
      sessionId: created.sessionId,
      text: "inspect",
    });
    const deadline = Date.now() + 10000;
    while (!events.some((e) => e.type === "turn" && e.status === "idle")) {
      if (Date.now() > deadline) throw new Error("turn timeout");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(events.filter((e) => e.type === "usage")).toEqual([
      expect.objectContaining({ provider: "codex", window5h: 42, weekly: 76 }),
      expect.objectContaining({ provider: "codex", window5h: 42, weekly: 76 }),
    ]);
    expect(events.some((e) => e.type === "agent_transcript")).toBe(true);
  } finally {
    await controller.shutdown();
  }
}, 15000);
