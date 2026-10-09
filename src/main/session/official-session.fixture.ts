import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { SessionController, type ControllerOptions } from "./controller.js";
import { unavailableLegacy } from "../official-profile.js";
import type { OfficialSessionSubmission } from "../../shared/official-session.js";
import type { WorkflowRecord } from "../workflow/official/runtime.js";
import { officialSessionSummary } from "../workflow/official/session-result.js";
import { type UiEvent } from "../../shared/ipc.js";
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
  const base = await mkdtemp(join(tmpdir(), "xh-official-session-")),
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
  return { c, create, home, root, workspaceId, sessionId, events, requests };
}
