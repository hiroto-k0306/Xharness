import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ChildHandoffs } from "./handoffs.js";
import { ChildRunner, AgentStoppedError } from "./runner.js";
import { loadAgentConfig } from "./definitions.js";
import { WorkflowRuntime } from "../workflow/runtime.js";
import { Router } from "../core/router.js";
import {
  FakeProvider,
  type FakeStep,
} from "../providers/fake/fake-provider.js";
import { type ProviderRequest } from "../providers/provider.js";
import { redact } from "../core/redact.js";
import { type ToolRegistry } from "../tools/registry.js";
import { SessionController } from "../session/controller.js";
const signal = () => new AbortController().signal;
const answer = (text: string): FakeStep => ({
  type: "message",
  stopReason: "end_turn",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
it("keeps selectable results across actual parent turns when the workflow is recreated", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-parent-handoff-"));
  const requests: ProviderRequest[] = [];
  const next = {
    agent: "explorer",
    description: "next",
    prompt: "new request",
    previousChildId: "",
  };
  const call = (name: string, input: unknown): FakeStep => ({
    type: "message",
    stopReason: "tool_use",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: name, name, input }],
    },
  });
  const provider = new FakeProvider({
    script: [
      call("Task", {
        agent: "explorer",
        description: "first",
        prompt: "first request",
      }),
      answer("previous child result"),
      answer("first parent done"),
      call("TaskHistory", {}),
      call("Task", next),
      answer("next child result"),
      answer("next parent done"),
    ],
    onRequest: (r) => requests.push(r),
  });
  const controller = new SessionController({
    home,
    model: "fake",
    provider,
    fake: true,
    version: "test",
    host: { pickFolder: async () => undefined },
    createTools: () => new Map(),
    emit: (e) => {
      if (e.type === "agent" && e.status === "done" && !next.previousChildId)
        next.previousChildId = e.agentId;
    },
  });
  await controller.init();
  const created = await controller.handle({
    type: "new_session",
    workspaceId: null,
  });
  if (!created.ok || !created.sessionId) throw new Error("fixture");
  const id = created.sessionId;
  const done = async () => {
    await (
      controller as unknown as {
        runtimes: Map<string, { done?: Promise<void> }>;
      }
    ).runtimes.get(id)?.done;
  };
  await controller.handle({ type: "send", sessionId: id, text: "first turn" });
  await done();
  expect(next.previousChildId).not.toBe("");
  await controller.handle({ type: "send", sessionId: id, text: "second turn" });
  await done();
  const childRequests = requests.filter((r) =>
    r.system.startsWith("You are explorer"),
  );
  expect(childRequests).toHaveLength(2);
  expect(childRequests[1]!.messages).toHaveLength(1);
  expect(JSON.stringify(childRequests[1]!.messages)).toContain(
    "previous child result",
  );
  expect(JSON.stringify(childRequests[1]!.messages)).not.toContain(
    "first parent done",
  );
  await controller.shutdown();
});
it("bounds handoffs, evicts old entries, rejects foreign ownership and copies views", () => {
  const h = new ChildHandoffs();
  for (let i = 0; i < 33; i++)
    h.remember({
      childId: String(i),
      name: "explorer",
      status: "done",
      result: "x".repeat(9000),
      questions: ["q".repeat(9000)],
    });
  expect(h.list()).toHaveLength(32);
  expect(h.has("0")).toBe(false);
  const view = h.list();
  expect(view[0]!.result.length + view[0]!.questions.join("").length).toBe(
    8000,
  );
  view[0]!.result = "changed";
  expect(h.list()[0]!.result).not.toBe("changed");
  expect(() => new ChildHandoffs().attach("new", "1")).toThrow();
  expect(h.attach("new")).toBe("new");
});
it("stores actual child questions and redacted results without resuming provider history", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-handoff-"));
  const requests: ProviderRequest[] = [];
  const provider = new FakeProvider({
    script: [
      {
        type: "message",
        stopReason: "tool_use",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "ask",
              name: "AskUserQuestion",
              input: {
                question: "Which choice synthetic-secret?",
                options: ["A", "B"],
              },
            },
          ],
        },
      },
      answer("new final synthetic-secret"),
    ],
    onRequest: (r) => requests.push(r),
  });
  const runner = new ChildRunner({
    home,
    parentId: "parent",
    router: new Router([provider]),
    createTools: () => new Map(),
    permission: async () => true,
    redact: (s) => redact(s, ["synthetic-secret"]),
  });
  const definition = { model: "claude:sonnet", tools: [] };
  await expect(
    runner.run(
      "explorer",
      definition,
      "first",
      home,
      signal(),
      undefined,
      "first-child",
    ),
  ).rejects.toBeInstanceOf(AgentStoppedError);
  expect(runner.handoffs.list()[0]).toMatchObject({
    status: "awaiting_user",
    questions: ["Which choice synthe…?"],
  });
  await runner.run(
    "explorer",
    definition,
    runner.handoffs.attach("answer A", "first-child"),
    home,
    signal(),
    undefined,
    "new-child",
  );
  expect(requests[1]!.messages).toHaveLength(1);
  expect(JSON.stringify(requests[1]!.messages)).toContain("Which choice");
  expect(JSON.stringify(requests)).not.toContain("synthetic-secret");
  expect(
    requests[1]!.tools.some((t) => ["Task", "Write", "Edit"].includes(t.name)),
  ).toBe(false);
  expect(runner.handoffs.list().map((x) => x.childId)).toEqual([
    "first-child",
    "new-child",
  ]);
});
it("exposes explicit selection through TaskHistory and validates foreign IDs before new requests", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-task-history-"));
  const requests: ProviderRequest[] = [];
  const provider = new FakeProvider({
    script: [answer("previous report"), answer("next report")],
    onRequest: (r) => requests.push(r),
  });
  const config = await loadAgentConfig(home);
  config.agents.explorer = { model: "claude:sonnet", tools: [] };
  const runtime = new WorkflowRuntime({
    home,
    cwd: home,
    parentId: "parent",
    config,
    router: new Router([provider]),
    createTools: () => new Map(),
    permission: async () => true,
    approve: async () => true,
    waveChecks: async () => ({ ok: true, output: "" }),
  });
  const tools = (
    runtime as unknown as { registry(base: ToolRegistry): ToolRegistry }
  ).registry(new Map());
  const task = tools.get("Task")!;
  await task.execute(
    { agent: "explorer", description: "first", prompt: "first" },
    signal(),
  );
  const entries = JSON.parse(
    (await tools.get("TaskHistory")!.execute({}, signal())).content,
  );
  expect(entries).toHaveLength(1);
  const selected = entries[0].childId;
  expect(
    await task.validate({
      agent: "explorer",
      description: "next",
      prompt: "new",
      previousChildId: "foreign",
    }),
  ).toBeTruthy();
  await task.execute(
    {
      agent: "explorer",
      description: "next",
      prompt: "new",
      previousChildId: selected,
    },
    signal(),
  );
  expect(JSON.stringify(requests[1]!.messages)).toContain("previous report");
  expect(requests[1]!.messages).toHaveLength(1);
  expect(tools.get("TaskHistory")!.readOnly).toBe(true);
});
