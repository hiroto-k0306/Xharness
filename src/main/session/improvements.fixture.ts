import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, vi } from "vitest";
import { SessionController } from "./controller.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { type UiEvent } from "../../shared/ipc.js";
import {
  type Improvement,
  type ImprovementAction,
} from "../../shared/improvements.js";
export const cases = [
  {
    id: "ping",
    prompt: "Reply pong",
    taskType: "text",
    difficulty: "small",
    criteria: "v1: output checked",
    environment: "fixed-local",
  },
];
const fixtures: { base: string; controllers: SessionController[] }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    for (const c of f.controllers) await c.shutdown();
    await rm(f.base, { recursive: true, force: true });
  }
});
export async function fixture(quotaNow?: () => number) {
  const base = await mkdtemp(join(tmpdir(), "xh-improve-")),
    home = join(base, "home"),
    root = join(base, "project");
  await mkdir(home);
  await mkdir(root);
  await writeFile(join(home, "config.yaml"), "workflow: {mode: off}\n");
  const controllers: SessionController[] = [],
    events: UiEvent[] = [],
    requests = vi.fn();
  fixtures.push({ base, controllers });
  const create = () => {
    const c = new SessionController({
      home,
      model: "fake",
      fake: true,
      version: "test",
      phase4: true,
      quotaNow,
      provider: new FakeProvider({ onRequest: requests }),
      host: { pickFolder: async () => root },
      emit: (e) => events.push(e),
    });
    controllers.push(c);
    return c;
  };
  const c = create();
  await c.init();
  const picked = await c.handle({ type: "pick_folder" });
  if (!picked.ok || !picked.workspaceId) throw new Error("workspace");
  const workspaceId = picked.workspaceId;
  const created = await c.handle({ type: "new_session", workspaceId });
  if (!created.ok || !created.sessionId) throw new Error("session");
  const sessionId = created.sessionId;
  const action = (request: ImprovementAction, controller = c, id = sessionId) =>
    controller.handle({
      type: "improvements",
      sessionId: id,
      operationId: "fixture",
      request,
    });
  const list = async (controller = c) => {
    const r = await action({ action: "list" }, controller);
    if (!r.ok || !r.improvements) throw new Error(JSON.stringify(r));
    return r.improvements;
  };
  const baseline = async () => {
    const r = await action({
      action: "create",
      name: "Fixed recipe",
      body: "Answer briefly",
      cases,
      source: {},
    });
    if (!r.ok) throw new Error(r.error);
    return r.improvements!.entries[0]!;
  };
  const evaluate = async (e: Improvement, versionId: string, passed = true) => {
    const p = await action({
      action: "prepare",
      id: e.id,
      revision: e.revision,
      versionId,
      caseId: "ping",
    });
    if (!p.ok || !p.preparedPrompt) throw new Error(JSON.stringify(p));
    const made = await c.handle({ type: "new_session", workspaceId });
    if (!made.ok || !made.sessionId) throw new Error("session");
    const id = made.sessionId;
    await c.handle({ type: "send", sessionId: id, text: p.preparedPrompt });
    await vi.waitFor(
      async () =>
        expect(
          (await c.state()).sessions.find((s) => s.id === id)?.status,
        ).toBe("idle"),
      { timeout: 5000 },
    );
    const result = await action({
      action: "record",
      id: e.id,
      revision: e.revision,
      versionId,
      caseId: "ping",
      sessionId: id,
      taskId: "current",
      passed,
      evidence: "User inspected saved ordinary output against v1",
    });
    if (!result.ok) throw new Error(result.error);
    return {
      e: result.improvements!.entries[0]!,
      id,
      view: result.improvements!,
    };
  };
  return {
    c,
    create,
    action,
    list,
    baseline,
    evaluate,
    home,
    root,
    workspaceId,
    sessionId,
    events,
    requests,
  };
}
