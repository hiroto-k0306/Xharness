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
