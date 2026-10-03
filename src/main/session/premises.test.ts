import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type UiEvent } from "../../shared/ipc.js";
import {
  FakeProvider,
  type FakeStep,
} from "../providers/fake/fake-provider.js";
import { type Tool } from "../tools/registry.js";
import { SessionController } from "./controller.js";
import { SessionStore } from "./store.js";
import { PREMISE_NOTICE } from "./premises.js";

beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Offline only");
    }),
  ),
);
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "xh-premise-")),
    cwd = join(home, "workspace");
  await mkdir(cwd);
  await writeFile(join(cwd, "AGENTS.md"), "ORIGINAL-INSTRUCTIONS");
  const events: UiEvent[] = [],
    requests = vi.fn();
  const tool: Tool = {
    spec: { name: "Read", description: "original", inputSchema: {} },
    readOnly: true,
    validate: async () => undefined,
    execute: vi.fn(async () => ({ content: "dummy" })),
  };
  const make = (script?: FakeStep[]) =>
    new SessionController({
      home,
      model: "fake",
      fake: true,
      version: "test",
      phase4: true,
      provider: new FakeProvider({
        onRequest: requests,
        script:
          script ??
          Array.from({ length: 5 }, () => ({
            type: "message" as const,
            message: {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: "offline" }],
            },
            stopReason: "end_turn" as const,
          })),
      }),
      host: { pickFolder: async () => cwd },
      emit: (e) => events.push(e),
      createTools: () => new Map([["Read", tool]]),
    });
  const controller = make();
  await controller.init();
  const ws = await controller.handle({ type: "pick_folder" });
  if (!ws.ok) throw new Error("fixture failed");
  const created = await controller.handle({
    type: "new_session",
    workspaceId: ws.workspaceId!,
  });
  if (!created.ok || !created.sessionId) throw new Error("fixture failed");
  const id = created.sessionId;
  const send = async (c: SessionController) => {
    events.length = 0;
    expect(
      await c.handle({ type: "send", sessionId: id, text: "offline" }),
    ).toMatchObject({ ok: true });
    await vi.waitFor(
      () =>
        expect(
          events.some((e) => e.type === "turn" && e.status === "idle"),
        ).toBe(true),
      { timeout: 10000 },
    );
  };
  return { home, cwd, id, events, requests, tool, make, controller, send };
}
it("resumes an unchanged prefix and persists only its hash without restoring permissions", async () => {
  const c = await fixture();
  await c.send(c.controller);
  const before = c.requests.mock.calls[0]![0];
  await c.controller.shutdown();
  const raw = await readFile(join(c.home, "sessions", "index.json"), "utf8");
  expect(JSON.parse(raw)[0].premiseHash).toMatch(/^v1:[a-f0-9]{64}$/);
  expect(raw).not.toContain("ORIGINAL-INSTRUCTIONS");
  expect(raw).not.toContain("inputSchema");
  await writeFile(
    join(c.home, "config.yaml"),
    "permissions: {rules: [{tool: Read, decision: deny}]}\n",
  );
  const resumed = c.make([
    {
      type: "message",
      stopReason: "tool_use",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "read", name: "Read", input: {} }],
      },
    },
    {
      type: "message",
      stopReason: "end_turn",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "offline" }],
      },
    },
  ]);
  await resumed.init();
  await c.send(resumed);
  expect(c.requests).toHaveBeenCalledTimes(3);
  expect(c.tool.execute).not.toHaveBeenCalled();
  expect(c.events).toContainEqual(
    expect.objectContaining({ type: "tool_result", isError: true }),
  );
  expect(c.requests.mock.calls[1]![0].system).toBe(before.system);
  expect(c.requests.mock.calls[1]![0].tools).toEqual(before.tools);
  await resumed.shutdown();
});
it.each(["instructions", "tools", "workflow"])(
  "stops before any provider/compaction request after %s changes",
  async (change) => {
    const c = await fixture();
    await c.send(c.controller);
    await c.controller.shutdown();
    const history = await readFile(
      join(c.home, "sessions", `${c.id}.jsonl`),
      "utf8",
    );
    if (change === "instructions")
      await writeFile(join(c.cwd, "AGENTS.md"), "CHANGED-INSTRUCTIONS");
    if (change === "tools")
      c.tool.spec = { ...c.tool.spec, description: "changed" };
    if (change === "workflow")
      await writeFile(join(c.home, "config.yaml"), "workflow: {mode: off}\n");
    const resumed = c.make();
    await resumed.init();
    await c.send(resumed);
    expect(c.requests).toHaveBeenCalledTimes(1);
    expect(c.events).toContainEqual(
      expect.objectContaining({ type: "error", message: PREMISE_NOTICE }),
    );
    expect(
      await readFile(join(c.home, "sessions", `${c.id}.jsonl`), "utf8"),
    ).toContain(history.trim());
    expect(
      await resumed.handle({ type: "send", sessionId: c.id, text: "/clear" }),
    ).toMatchObject({ ok: true });
    await resumed.shutdown();
  },
);
it.each([true, false])(
  "handles legacy history (has assistant=%s) without inventing its premise",
  async (assistant) => {
    const c = await fixture();
    await c.controller.shutdown();
    const store = new SessionStore(c.home);
    await store.load();
    await store.append(
      c.id,
      [
        { role: "user", content: [{ type: "text", text: "legacy" }] },
        ...(assistant
          ? [
              {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "legacy response" }],
              },
            ]
          : []),
      ],
      (s) => s,
    );
    const resumed = c.make();
    await resumed.init();
    await c.send(resumed);
    expect(c.requests).toHaveBeenCalledTimes(assistant ? 0 : 1);
    if (assistant)
      expect(c.events).toContainEqual(
        expect.objectContaining({ message: PREMISE_NOTICE }),
      );
    await resumed.shutdown();
  },
);
