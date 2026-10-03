import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import image from "../../../test/fixtures/images/pixel.js";
import { SessionController } from "./controller.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { type UiEvent } from "../../shared/ipc.js";
import { type ProviderRequest } from "../providers/provider.js";
import { exportExecutionReport } from "./report.js";
import { toClaudeRequest } from "../providers/claude/convert.js";
import { toCodexInput } from "../providers/codex/convert.js";
import { itemsFromMessages } from "./transcript.js";
it("keeps saved image bytes through compact but omits them from subsequent requests", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-image-compact-"));
  const requests: ProviderRequest[] = [];
  const c = new SessionController({
    home,
    model: "fake",
    provider: new FakeProvider({
      onRequest: (r) => requests.push(structuredClone(r)),
    }),
    fake: true,
    phase4: true,
    version: "test",
    emit: () => {},
    host: { pickFolder: async () => undefined },
    createTools: () => new Map(),
  });
  await c.init();
  const created = await c.handle({ type: "new_session", workspaceId: null });
  if (!created.ok || !created.sessionId)
    throw new Error("session creation failed");
  const sessionId = created.sessionId;
  async function send(text: string, images?: (typeof image)[]) {
    expect(
      await c.handle({ type: "send", sessionId, text, images }),
    ).toMatchObject({ ok: true });
    const end = Date.now() + 5000;
    while (
      (await c.state()).sessions.find((s) => s.id === sessionId)!.status !==
      "idle"
    ) {
      if (Date.now() > end) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  await send("old", [image]);
  await send("recent");
  await send("latest");
  expect(
    await c.handle({ type: "send", sessionId, text: "/compact" }),
  ).toMatchObject({ ok: true });
  await send("after compact");
  expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain(image.data);
  await c.shutdown();
  expect(
    await readFile(join(home, "sessions", sessionId + ".jsonl"), "utf8"),
  ).toContain(image.data);
});
it("rejects a sixth attachment without provider calls", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-image-limit-"));
  const requests: ProviderRequest[] = [];
  const c = new SessionController({
    home,
    model: "fake",
    provider: new FakeProvider({ onRequest: (r) => requests.push(r) }),
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
      images: Array(6).fill(image),
    }),
  ).toMatchObject({ ok: false, error: "画像の添付は1メッセージ5枚までです。" });
  expect(requests).toHaveLength(0);
  await c.shutdown();
});
it("preserves attachment bytes for providers and resume, while receipts/traces/HTML only contain metadata", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-image-session-"));
  const requests: ProviderRequest[] = [],
    events: UiEvent[] = [];
  const make = () =>
    new SessionController({
      home,
      model: "fake",
      provider: new FakeProvider({ onRequest: (r) => requests.push(r) }),
      fake: true,
      secrets: [image.data],
      version: "test",
      emit: (e) => events.push(e),
      host: { pickFolder: async () => undefined },
      createTools: () => new Map(),
    });
  const c = make();
  await c.init();
  const { sessionId } = (await c.handle({
    type: "new_session",
    workspaceId: null,
  })) as { sessionId: string };
  expect(
    await c.handle({ type: "send", sessionId, text: "", images: [image] }),
  ).toMatchObject({ ok: true });
  const end = Date.now() + 3000;
  while (!events.some((e) => e.type === "turn" && e.status === "idle")) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await c.shutdown(10000);
  expect(requests[0]!.messages[0]!.content).toContainEqual({
    type: "image",
    ...image,
  });
  expect(
    JSON.stringify(
      toClaudeRequest({ ...requests[0]!, model: "claude-haiku-4-5" }),
    ),
  ).toContain(image.data);
  expect(JSON.stringify(toCodexInput(requests[0]!.messages))).toContain(
    image.data,
  );
  const receipts = await readFile(
    join(home, "receipts", sessionId + ".jsonl"),
    "utf8",
  );
  const trace = await readFile(
    join(home, "traces", sessionId + ".jsonl"),
    "utf8",
  );
  for (const record of [receipts, trace]) {
    expect(record).not.toContain(image.data);
    expect(record).toContain("image/png");
  }
  const output = join(home, "report.html");
  await exportExecutionReport(home, sessionId, output, (s) => s);
  expect(await readFile(output, "utf8")).not.toContain(image.data);
  expect(
    await readFile(join(home, "sessions", sessionId + ".jsonl"), "utf8"),
  ).toContain(image.data);
  events.length = 0;
  const resumed = make();
  await resumed.init();
  await resumed.handle({ type: "open_session", sessionId });
  expect(events.find((e) => e.type === "transcript")).toMatchObject({
    items: [
      expect.objectContaining({ kind: "user", images: [image] }),
      expect.anything(),
    ],
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
