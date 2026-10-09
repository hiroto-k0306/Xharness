import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OfficialWorkflowService } from "./service.js";
import { fixtureWorkflowOptions, fixtureAgents } from "./fixtures.js";
import type { OfficialWorkflowView } from "../../../shared/official-workflow.js";
const homes: string[] = [];
const services: OfficialWorkflowService[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.close();
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});
async function setup(operation = false, onChange?: () => void) {
  const home = await mkdtemp(join(tmpdir(), "xh-approval-chat-"));
  homes.push(home);
  const cwd = join(home, "project");
  await mkdir(cwd);
  await writeFile(join(cwd, "add.mjs"), "export const add=(a,b)=>a-b;\n");
  const fake = fixtureAgents("codex", false);
  let outcome: unknown;
  if (operation) {
    const run = fake.agents.codex.run;
    fake.agents.codex.run = async (request, signal) => {
      if (request.phase === "implement") {
        outcome = await request.approve(
          "native/operation",
          {
            requestId: request.requestId,
            sessionId: "native-thread",
            turnId: "turn",
            itemId: "operation",
            command: "Get-Content add.mjs",
            cwd,
            targets: ["add.mjs"],
            reason: "fixture",
          },
          signal,
        );
        if (outcome !== true)
          return {
            status: "cancelled",
            dispatched: true,
            observedModels: [],
            usage: null,
            elapsedMs: 1,
          };
      }
      return run(request, signal);
    };
  }
  const service = new OfficialWorkflowService({
    home,
    fake: true,
    onChange,
    options: async () => fixtureWorkflowOptions(cwd, { agents: fake.agents }),
  });
  services.push(service);
  const done = service.submitSession(
    {
      sessionId: "chat-a",
      cwd,
      model: "claude:opus",
      effort: "high",
      text: "auto-work: fix addition",
      history: [],
      automaticWork: true,
    },
    new AbortController().signal,
  );
  const planned = await wait(service, (view) => !!view.approval);
  return { service, done, fake, planned, outcome: () => outcome };
}
async function wait(
  service: OfficialWorkflowService,
  check: (view: OfficialWorkflowView) => boolean,
) {
  for (let i = 0; i < 500; i++) {
    const view = service.view();
    if (check(view)) return view;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("approval fixture timed out");
}
it("requires current chat/workflow/approval identity and digest, then consumes explicit plan denial once", async () => {
  const { service, done, fake, planned } = await setup();
  const pending = planned.approval!;
  expect(pending.sessionId).toBe("chat-a");
  expect(pending.expiresAt - Date.now()).toBeLessThanOrEqual(600000);
  expect(pending.expiresAt - Date.now()).toBeGreaterThan(590000);
  const base = {
    action: "approve" as const,
    id: pending.id,
    approvalId: pending.approvalId,
    digest: pending.digest,
    sessionId: "chat-a",
  };
  for (const invalid of [
    { ...base, sessionId: "chat-b" },
    { ...base, sessionId: undefined },
    { ...base, approvalId: undefined },
    { ...base, approvalId: "stale-id" },
    { ...base, digest: "0".repeat(64) },
  ]) {
    await service.command(invalid);
    expect(service.view().approval).toEqual(pending);
  }
  await service.command({
    action: "cancel",
    id: pending.id,
    sessionId: "chat-b",
  });
  expect(service.view().approval).toEqual(pending);
  await service.command({ ...base, allow: false });
  await done;
  expect(service.view().approval).toBeUndefined();
  expect(fake.requests.map((r) => r.phase)).toEqual(["plan"]);
  expect(service.view().records[0]!.record.error).toBe("plan-denied");
  await service.command({ ...base, allow: true });
  expect(fake.requests.map((r) => r.phase)).toEqual(["plan"]);
});
it("rejects an expired plan without requiring timer delivery and starts no implementation", async () => {
  const { service, done, fake, planned } = await setup();
  const pending = planned.approval!;
  const clock = vi.spyOn(Date, "now").mockReturnValue(pending.expiresAt);
  await service.command({
    action: "approve",
    id: pending.id,
    approvalId: pending.approvalId,
    digest: pending.digest,
    sessionId: "chat-a",
    allow: true,
  });
  clock.mockRestore();
  await done;
  expect(service.view().approval).toBeUndefined();
  expect(service.view().records[0]!.record.error).toBe("plan-approval-expired");
  expect(fake.requests.map((r) => r.phase)).toEqual(["plan"]);
});
it("binds operation decisions/cancellation to app chat independently of native thread and ignores duplicates", async () => {
  const { service, done, planned, outcome, fake } = await setup(true);
  const pendingPlan = planned.approval!;
  await service.command({
    action: "approve",
    id: pendingPlan.id,
    approvalId: pendingPlan.approvalId,
    digest: pendingPlan.digest,
    sessionId: "chat-a",
  });
  const pending = (await wait(service, (view) => !!view.operationApproval))
    .operationApproval!;
  expect(pending.sessionId).toBe("native-thread");
  expect(pending.conversationSessionId).toBe("chat-a");
  const decision = {
    action: "tool_decision" as const,
    id: pending.workflowId,
    approvalId: pending.approvalId,
    digest: pending.digest,
    allow: true,
  };
  for (const sessionId of [undefined, "native-thread", "chat-b"]) {
    await service.command({ ...decision, sessionId });
    expect(service.view().operationApproval).toEqual(pending);
  }
  await service.command({
    action: "cancel",
    id: pending.workflowId,
    sessionId: "chat-b",
  });
  expect(service.view().operationApproval).toEqual(pending);
  await service.command({ ...decision, sessionId: "chat-a" });
  await service.command({ ...decision, sessionId: "chat-a", allow: false });
  await done;
  expect(outcome()).toBe(true);
  expect(service.view().operationApproval).toBeUndefined();
  expect(fake.requests.map((r) => r.phase)).toEqual([
    "plan",
    "implement",
    "review",
  ]);
});
it("notifies persisted and ephemeral changes while callback exceptions never affect workflow persistence", async () => {
  const changed = vi.fn(() => {
    throw new Error("desktop notification failed");
  });
  const { service, done, planned } = await setup(false, changed);
  const pending = planned.approval!;
  const initial = changed.mock.calls.length;
  expect(initial).toBeGreaterThan(0);
  await service.command({
    action: "cancel",
    id: pending.id,
    sessionId: "chat-a",
  });
  await done;
  expect(changed.mock.calls.length).toBeGreaterThan(initial);
  expect(service.view().records[0]!.record.status).toBe("cancelled");
  expect(service.view().approval).toBeUndefined();
});
