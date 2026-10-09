import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { SessionController, type ControllerOptions } from "./controller.js";
import { unavailableLegacy } from "../official-profile.js";
import type { OfficialSessionSubmission } from "../../shared/official-session.js";
import type { WorkflowRecord } from "../workflow/official/runtime.js";
import { officialSessionSummary } from "../workflow/official/session-result.js";
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
export async function fixture(
  quotaNow?: () => number,
  extra: Partial<ControllerOptions> = {},
) {
  const base = await mkdtemp(join(tmpdir(), "xh-improve-")),
    home = join(base, "home"),
    root = join(base, "project");
  await mkdir(home);
  await mkdir(root);
  await writeFile(join(home, "config.yaml"), "workflow: {mode: off}\n");
  const controllers: SessionController[] = [],
    events: UiEvent[] = [],
    requests = vi.fn(
      async (r: OfficialSessionSubmission, signal: AbortSignal) => {
        signal.throwIfAborted();
        const id = randomUUID();
        const record: WorkflowRecord = {
          version: 1,
          id,
          sessionId: r.sessionId,
          goal: r.text,
          cwd: r.cwd,
          simulated: true,
          startedAt: new Date(Date.now() - 1).toISOString(),
          finishedAt: new Date().toISOString(),
          status: "completed",
          next: "complete",
          base: "",
          head: "",
          correctionRounds: 0,
          inputIntent: "question",
          answer: "pong",
          calls: [
            {
              requestId: randomUUID(),
              phase: "conversation",
              provider: "claude",
              requestedModel: "claude-haiku-5-5",
              effort: "medium",
              observedModels: ["claude-haiku-5-5"],
              status: "completed",
              dispatched: true,
              usage: null,
              elapsedMs: 1,
            },
          ],
          tools: [],
          commits: [],
          checks: [],
          reviews: [],
        };
        const folder = join(home, "official-workflows", id);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "workflow.json"), JSON.stringify(record));
        return {
          workflowId: id,
          status: record.status,
          summary: officialSessionSummary(record, false),
        };
      },
    );
  fixtures.push({ base, controllers });
  const create = () => {
    const c = new SessionController({
      home,
      model: "claude:opus",
      fake: true,
      version: "test",
      phase4: true,
      quotaNow,
      provider: unavailableLegacy("claude"),
      officialSession: requests,
      host: { pickFolder: async () => root },
      emit: (e) => events.push(e),
      ...extra,
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
  const baseline = async (body = "Answer briefly") => {
    const r = await action({
      action: "create",
      name: "Fixed recipe",
      body,
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
