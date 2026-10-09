import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import image from "../../../test/fixtures/images/pixel.js";
import { SessionController } from "./controller.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { type UiEvent } from "../../shared/ipc.js";
import { type ProviderRequest } from "../providers/provider.js";
import { exportExecutionReport } from "./report.js";
import { SessionStore } from "./store.js";
import { type Message } from "../core/types.js";
import { withSessionTrace, beginTrace } from "../core/trace.js";
import { itemsFromMessages } from "./transcript.js";
it.each([1, 6])(
  "rejects %i attachments on the official path without model calls",
  async (count) => {
    const home = await mkdtemp(join(tmpdir(), "xh-image-limit-"));
    const requests: ProviderRequest[] = [];
    const official = vi.fn(async () => ({
      workflowId: "unused",
      status: "completed" as const,
      summary: "unused",
    }));
    const c = new SessionController({
      home,
      model: "claude:opus",
      provider: new FakeProvider({ onRequest: (r) => requests.push(r) }),
      officialSession: official,
      fake: true,
      version: "test",
      emit: () => {},
      host: { pickFolder: async () => undefined },
    });
    await c.init();
    const result = await c.handle({ type: "new_session", workspaceId: null });
    expect(
      await c.handle({
        type: "send",
        sessionId: result.ok ? result.sessionId! : "",
        text: "six",
        images: Array(count).fill(image),
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("画像") });
    expect(requests).toHaveLength(0);
    expect(official).not.toHaveBeenCalled();
    await c.shutdown();
  },
);
it("preserves legacy attachment bytes and transcript on resume while report and trace expose metadata only", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-image-history-"));
  const store = new SessionStore(home);
  await store.load();
  const sessionId = "image-history";
  await store.save({
    id: sessionId,
    title: "保存済み画像履歴",
    workspaceId: null,
    cwd: home,
    model: "fake",
    effort: "high",
    readOnly: true,
    createdAt: 1,
    updatedAt: 2,
    providers: [],
  });
  const messages: Message[] = [
    { role: "user", content: [{ type: "image", ...image }] },
  ];
  await store.append(sessionId, messages, (s) => s);
  await withSessionTrace(
    home,
    sessionId,
    (s) => s,
    async () => {
      const span = beginTrace(
        "llm",
        "保存履歴fixture（通信なし）",
        { messages },
        true,
      );
      span.end({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "履歴" }],
        },
      });
    },
  );
  const trace = await readFile(
    join(home, "traces", sessionId + ".jsonl"),
    "utf8",
  );
  expect(trace).not.toContain(image.data);
  expect(trace).toContain("image/png");
  const output = join(home, "report.html");
  await exportExecutionReport(home, sessionId, output, (s) => s);
  expect(await readFile(output, "utf8")).not.toContain(image.data);
  expect(
    await readFile(join(home, "sessions", sessionId + ".jsonl"), "utf8"),
  ).toContain(image.data);
  const events: UiEvent[] = [];
  const resumed = new SessionController({
    home,
    model: "fake",
    provider: new FakeProvider(),
    fake: true,
    version: "test",
    emit: (e) => events.push(e),
    host: { pickFolder: async () => undefined },
  });
  await resumed.init();
  await resumed.handle({ type: "open_session", sessionId });
  expect(events.find((e) => e.type === "transcript")).toMatchObject({
    items: [expect.objectContaining({ kind: "user", images: [image] })],
  });
  expect(
    await resumed.handle({
      type: "send",
      sessionId,
      text: "bad",
      images: [{ ...image, data: "bad" }],
    }),
  ).toMatchObject({ ok: false });
  await resumed.shutdown();
  expect(
    itemsFromMessages([
      {
        role: "user",
        content: [
          { type: "image", ...image },
          { type: "text", text: "[MCP update] internal note" },
        ],
      },
    ]),
  ).toEqual([expect.objectContaining({ kind: "user", images: [image] })]);
});
