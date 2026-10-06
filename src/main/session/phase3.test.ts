import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { type UiEvent } from "../../shared/ipc.js";
import {
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
} from "../providers/provider.js";
import { SessionController } from "./controller.js";
import { SessionStore } from "./store.js";
const usage = { inputTokens: 1, outputTokens: 1 };
const finish: ProviderEvent = {
  type: "message_done",
  stopReason: "end_turn",
  usage,
  message: { role: "assistant", content: [{ type: "text", text: "done" }] },
};
async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function provider(
  id: "claude" | "codex",
  scripts: ProviderEvent[][],
  requests: ProviderRequest[],
): Provider {
  return {
    id,
    models: () => [
      {
        id: id === "claude" ? "claude-opus-5-5" : "gpt-6-luna",
        contextTokens: 272000,
      },
    ],
    async *stream(request) {
      requests.push(structuredClone(request));
      yield* scripts.shift() ?? [finish];
    },
  };
}
async function setup(a: Provider, b: Provider, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), "xh-phase3-"));
  const events: UiEvent[] = [];
  const controller = new SessionController({
    provider: a,
    providers: [a, b],
    model: "claude-opus-5-5",
    home,
    fake: true,
    version: "test",
    host: { pickFolder: async () => undefined },
    emit: (event) => events.push(event),
    ...extra,
  });
  await controller.init();
  const created = await controller.handle({
    type: "new_session",
    workspaceId: null,
  });
  if (!created.ok || !created.sessionId) throw new Error("create failed");
  return { controller, home, events, sessionId: created.sessionId };
}
it("switches provider at the next round, keeps opaque history and scopes /model to the session", async () => {
  const aRequests: ProviderRequest[] = [],
    bRequests: ProviderRequest[] = [];
  const thinking = {
    type: "reasoning" as const,
    provider: "claude" as const,
    payload: { type: "thinking", thinking: "opaque", signature: "unchanged" },
  };
  const call = {
    type: "tool_use" as const,
    id: "toolu_read",
    name: "Read",
    input: { path: "file" },
  };
  const a = provider(
    "claude",
    [
      [
        call,
        {
          type: "message_done",
          usage,
          stopReason: "tool_use",
          message: { role: "assistant", content: [thinking, call] },
        },
      ],
    ],
    aRequests,
  );
  const b = provider("codex", [[finish]], bRequests);
  const { controller, events, sessionId, home } = await setup(a, b, {
    createTools: () =>
      new Map([
        [
          "Read",
          {
            spec: { name: "Read", description: "test", inputSchema: {} },
            readOnly: true,
            validate: async () => undefined,
            execute: async () => ({ content: "test" }),
          },
        ],
      ]),
  });
  await controller.handle({ type: "send", sessionId, text: "Read a file" });
  await until(() => events.some((e) => e.type === "permission_request"));
  expect(
    await controller.handle({
      type: "send",
      sessionId,
      text: "/model codex:luna low",
    }),
  ).toMatchObject({ ok: true });
  const pending = events.find((e) => e.type === "permission_request");
  if (pending?.type !== "permission_request") throw new Error("no permission");
  await controller.handle({
    type: "permission_response",
    sessionId,
    requestId: pending.requestId,
    decision: "deny",
  });
  await until(() =>
    events.some((e) => e.type === "turn" && e.status === "idle"),
  );
  await controller.shutdown();
  expect(aRequests).toHaveLength(1);
  expect(bRequests).toHaveLength(1);
  expect(
    bRequests[0]!.messages
      .flatMap((m) => m.content)
      .some((b) => b.type === "reasoning"),
  ).toBe(false);
  const store = new SessionStore(home);
  await store.load();
  expect(
    (await store.messages(sessionId)).flatMap((m) => m.content),
  ).toContainEqual(thinking);
  expect(
    (await store.messages(sessionId)).some((m) =>
      m.content.some((b) => b.type === "text" && b.text.startsWith("/model")),
    ),
  ).toBe(false);
  const restarted = new SessionController({
    provider: a,
    providers: [a, b],
    model: "claude-opus-5-5",
    home,
    fake: true,
    version: "test",
    host: { pickFolder: async () => undefined },
    emit: (event) => events.push(event),
  });
  await restarted.init();
  const other = await restarted.handle({
    type: "new_session",
    workspaceId: null,
  });
  expect(other.ok).toBe(true);
  if (!other.ok) throw new Error("create failed");
  expect(
    (await restarted.state()).sessions.find((s) => s.id === other.sessionId)
      ?.model,
  ).toBe("claude-opus-5-5");
  await restarted.shutdown();
});
it("persists fallback for this session and delivers missing usage as unknown to the UI", async () => {
  const aRequests: ProviderRequest[] = [],
    bRequests: ProviderRequest[] = [];
  const a = provider(
    "claude",
    [[{ type: "rate_limited", retryAfterSec: 600 }]],
    aRequests,
  );
  const b = provider(
    "codex",
    [
      [
        {
          type: "usage",
          provider: "codex",
          windows: [
            { name: "primary", usedPercent: 87, windowMinutes: 300 },
            { name: "secondary" },
          ],
        },
        finish,
      ],
    ],
    bRequests,
  );
  const { controller, events, sessionId } = await setup(a, b, {
    fallback: { claude: "codex:luna" },
  });
  await controller.handle({ type: "send", sessionId, text: "continue" });
  await until(() =>
    events.some((e) => e.type === "turn" && e.status === "idle"),
  );
  await controller.shutdown();
  expect(
    (await controller.state()).sessions.find((s) => s.id === sessionId)?.model,
  ).toBe("gpt-6-luna");
  expect((await controller.state()).model).toBe("claude-opus-5-5");
  expect(events.find((e) => e.type === "usage")).toMatchObject({
    provider: "codex",
    window5h: 87,
    weekly: undefined,
  });
  expect(
    events.some((e) => e.type === "error" && e.message.includes("fallback")),
  ).toBe(true);
});
