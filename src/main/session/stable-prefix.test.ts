// preserved thinking: 同じセッションでは system を変えない(途中で AGENTS.md が変わっても)
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { type UiEvent } from "../../shared/ipc.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { SessionController } from "./controller.js";

it("keeps the session's system prompt fixed even when AGENTS.md changes mid-session", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-prefix-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "xh-prefix-ws-"));
  await writeFile(join(workspace, "AGENTS.md"), "RULE-ONE");
  const systems: string[] = [];
  const events: UiEvent[] = [];
  const controller = new SessionController({
    provider: new FakeProvider({ onRequest: (r) => systems.push(r.system) }),
    model: "fake",
    home,
    fake: true,
    version: "1",
    host: { pickFolder: async () => workspace },
    emit: (e) => events.push(e),
    createTools: () => new Map(),
  });
  await controller.init();
  const { workspaceId } = (await controller.handle({
    type: "pick_folder",
  })) as { workspaceId: string };
  const { sessionId } = (await controller.handle({
    type: "new_session",
    workspaceId,
  })) as { sessionId: string };
  const idle = (n: number) =>
    events.filter((e) => e.type === "turn" && e.status === "idle").length >= n;
  const until = async (check: () => boolean) => {
    const end = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > end) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  await controller.handle({ type: "send", sessionId, text: "hi" });
  await until(() => idle(1));
  await writeFile(join(workspace, "AGENTS.md"), "RULE-TWO");
  await controller.handle({ type: "send", sessionId, text: "again" });
  await until(() => idle(2));
  expect(systems).toHaveLength(2);
  expect(systems[0]).toContain("RULE-ONE");
  expect(systems[1]).toBe(systems[0]);
  expect(systems[0]).toContain("do not prefix commands with cd");
});
