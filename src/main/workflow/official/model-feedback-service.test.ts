import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfficialWorkflowService } from "./service.js";
import { fixtureAgents, fixtureWorkflowOptions } from "./fixtures.js";
import type { WorkflowRecord } from "./runtime.js";
it("fresh completed service evidence is persisted and becomes the next planner reference without rewriting previous history", async () => {
  const root = await mkdtemp(join(tmpdir(), "xh-feedback-service-")),
    cwd = join(root, "project"),
    home = join(root, "home");
  await mkdir(cwd);
  await writeFile(join(cwd, "add.mjs"), "export const add=(a,b)=>a-b;\n");
  const prompts: unknown[] = [];
  const current: { instance?: OfficialWorkflowService } = {};
  const seen = new Set<string>();
  const drain = () => {
    const a = current.instance?.view().approval;
    if (a && !seen.has(a.approvalId)) {
      seen.add(a.approvalId);
      void current.instance!.command({
        action: "approve",
        id: a.id,
        approvalId: a.approvalId,
        digest: a.digest,
        sessionId: "conversation",
        allow: true,
      });
    }
  };
  const instance = new OfficialWorkflowService({
    home,
    fake: true,
    onChange: drain,
    options: async (path) => {
      const agents = fixtureAgents("claude", false).agents;
      const run = agents.claude.run.bind(agents.claude);
      agents.claude.run = async (request, signal) => {
        if (request.phase === "plan")
          prompts.push(JSON.parse(request.prompt).modelFeedback);
        return run(request, signal);
      };
      return fixtureWorkflowOptions(path, { agents, simulated: false });
    },
  });
  current.instance = instance;
  try {
    const submit = () =>
      instance!.submitSession(
        {
          sessionId: "conversation",
          cwd,
          model: "claude:opus",
          effort: "high",
          text: "auto-work: fix",
          history: [],
          automaticWork: true,
        },
        new AbortController().signal,
      );
    const first = await submit();
    expect(first.status).toBe("completed");
    const firstPath = join(
        home,
        "official-workflows",
        first.workflowId,
        "workflow.json",
      ),
      before = await readFile(firstPath, "utf8"),
      record = JSON.parse(before) as WorkflowRecord;
    expect(record.modelPerformance?.version).toBe(1);
    expect(record.modelPerformance?.samples).toHaveLength(1);
    expect(record.modelPerformance!.samples[0]!.timing.activeMs).not.toBeNull();
    expect(prompts[0]).toMatchObject({ groups: [] });
    await writeFile(join(cwd, "add.mjs"), "export const add=(a,b)=>a-b;\n");
    const second = await submit();
    expect(second.status).toBe("completed");
    expect(prompts[1]).toMatchObject({
      groups: [
        {
          provider: "claude",
          modelId: "fixture-haiku",
          effort: null,
          sampleCount: 1,
        },
      ],
    });
    expect(await readFile(firstPath, "utf8")).toBe(before);
  } finally {
    await instance.close();
    await rm(root, { recursive: true, force: true });
  }
});
