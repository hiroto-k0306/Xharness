import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionController } from "./controller.js";
import {
  FakeProvider,
  type FakeStep,
} from "../providers/fake/fake-provider.js";
import type { ProviderRequest } from "../providers/provider.js";
import type { UiEvent } from "../../shared/ipc.js";

const text = (value: string): FakeStep => ({
  type: "message",
  stopReason: "end_turn",
  message: { role: "assistant", content: [{ type: "text", text: value }] },
});
const tool = (name: string, input: unknown): FakeStep => ({
  type: "message",
  stopReason: "tool_use",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: name, name, input }],
  },
});

it("answers questions, explanation and post-review chat once per turn with preserved history", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-conversation-"));
  const events: UiEvent[] = [],
    requests: ProviderRequest[] = [];
  const main = new FakeProvider({
    onRequest: (r) => requests.push(structuredClone(r)),
    script: [
      text("回答1"),
      text("回答2"),
      text("加算する関数です。"),
      tool("SkipPlan", { reason: "Small fix" }),
      tool("Write", { path: "fix.txt", content: "fix" }),
      tool("RequestReview", { summary: "Implemented" }),
      text("実装とレビューが完了しました。"),
      text("どういたしまして。"),
      text("また後で。"),
      text("must not send"),
    ],
  });
  let reviews = 0;
  const reviewer = new FakeProvider({
    provider: "codex",
    onRequest: () => reviews++,
    script: [text("[]")],
  });
  await writeFile(
    join(home, "config.yaml"),
    "permissions: {mode: acceptEdits}\nworkflow: {mode: auto, worktrees: false}\n",
  );
  const controller = new SessionController({
    home,
    provider: main,
    providers: [main, reviewer],
    model: "claude-opus-5-5",
    fake: true,
    phase4: true,
    version: "test",
    host: { pickFolder: async () => undefined },
    emit: (e) => events.push(e),
  });
  try {
    await controller.init();
    const made = await controller.handle({
      type: "new_session",
      workspaceId: null,
    });
    if (!made.ok || !made.sessionId) throw new Error("session missing");
    const sessionId = made.sessionId;
    const prompts = [
      "何ができますか？",
      "使い方を教えて",
      "コードの説明だけして",
      "fix.txtを追加して",
      "ありがとう",
      "また後で",
    ];
    for (let i = 0; i < prompts.length; i++) {
      events.length = 0;
      expect(
        await controller.handle({ type: "send", sessionId, text: prompts[i]! }),
      ).toMatchObject({ ok: true });
      await vi.waitFor(
        () =>
          expect(
            events.some((e) => e.type === "turn" && e.status === "idle"),
          ).toBe(true),
        { timeout: 10000 },
      );
      expect(
        events.find((e) => e.type === "turn" && e.status === "idle"),
      ).toMatchObject({
        stopCause: i === 3 ? "workflow_complete" : "end_turn",
      });
      expect(requests).toHaveLength(i < 3 ? i + 1 : i + 4);
      expect(reviews).toBe(i < 3 ? 0 : 1);
    }
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
      "実装とレビューが完了しました。",
    );
    expect(JSON.stringify(requests)).not.toContain("must not send");
  } finally {
    await controller.shutdown();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
}, 30000);
