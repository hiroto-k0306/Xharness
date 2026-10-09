import { expect, it, vi } from "vitest";
import { AgentTasks } from "./tasks.js";
import { AgentStoppedError } from "./runner.js";

function setup() {
  const parent = new AbortController();
  const pending = new Map<
    string,
    { signal: AbortSignal; resolve: (result: { text: string }) => void }
  >();
  const run = vi.fn(
    (id: string, _input: Record<string, unknown>, signal: AbortSignal) =>
      new Promise<{ text: string }>((resolve, reject) => {
        pending.set(id, { signal, resolve });
        signal.addEventListener(
          "abort",
          () => reject(new Error("synthetic-sensitive-value")),
          { once: true },
        );
        if (signal.aborted) reject(new Error("cancelled before launch"));
      }),
  );
  const tasks = new AgentTasks(run);
  const tools = tasks.tools();
  const start = () =>
    JSON.parse(
      tasks.start(
        { description: "調査", agent: "explorer", prompt: "inspect" },
        parent.signal,
      ),
    ).taskId as string;
  const invoke = async (name: string, input: unknown = {}) =>
    JSON.parse((await tools.get(name)!.execute(input, parent.signal)).content);
  return { tasks, parent, pending, start, invoke, tools };
}

it("returns IDs immediately, reports results and stops only the selected child", async () => {
  const s = setup();
  const first = s.start(),
    second = s.start();
  await Promise.resolve();
  expect(await s.invoke("TaskList")).toHaveLength(2);
  expect(await s.invoke("TaskOutput", { taskId: first })).toMatchObject({
    status: "running",
  });
  expect(await s.invoke("TaskStop", { taskId: first })).toMatchObject({
    status: "stopped",
  });
  expect(s.parent.signal.aborted).toBe(false);
  expect(s.pending.get(second)!.signal.aborted).toBe(false);
  const waiting = s.invoke("TaskOutput", { taskId: second, wait: true });
  s.pending.get(second)!.resolve({ text: "調査結果" });
  expect(await waiting).toMatchObject({ status: "done", result: "調査結果" });
  expect(JSON.stringify(await s.invoke("TaskList"))).not.toContain(
    "synthetic-sensitive-value",
  );
  await s.tasks.close();
});

it("parent cancellation stops all children including queued launches", async () => {
  const s = setup();
  s.start();
  s.start();
  s.parent.abort();
  await s.tasks.close();
  expect([...s.pending.values()].every((p) => p.signal.aborted)).toBe(true);
});

it("cleanup stops pending children and the next turn cannot access old IDs", async () => {
  const s = setup();
  const id = s.start();
  await s.tasks.close();
  expect(await s.invoke("TaskOutput", { taskId: id })).toMatchObject({
    status: "stopped",
  });
  s.tasks.beginTurn();
  expect(
    await s.tools.get("TaskOutput")!.validate({ taskId: id }),
  ).toBeTruthy();
  expect(await s.invoke("TaskList")).toEqual([]);
});

it("enforces the concurrent limit and frees a slot after completion", async () => {
  const s = setup();
  const first = s.start();
  s.start();
  s.start();
  expect(() => s.start()).toThrow(/上限/);
  await Promise.resolve();
  s.pending.get(first)!.resolve({ text: "done" });
  await s.invoke("TaskOutput", { taskId: first, wait: true });
  expect(() => s.start()).not.toThrow();
  await s.tasks.close();
});

it("wait timeout returns running and cancellation interrupts waiting", async () => {
  vi.useFakeTimers();
  try {
    const s = setup();
    const id = s.start();
    const waiting = s.invoke("TaskOutput", {
      taskId: id,
      wait: true,
      timeoutSec: 1,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toMatchObject({ status: "running" });
    const cancelled = expect(
      s.invoke("TaskOutput", { taskId: id, wait: true }),
    ).rejects.toThrow();
    await Promise.resolve();
    s.parent.abort();
    await cancelled;
    await s.tasks.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["agent_stopped", "awaiting_user"] as const)(
  "does not label a child's %s as completion",
  async (reason) => {
    const tasks = new AgentTasks(async () => {
      throw new AgentStoppedError(reason, "確認が必要です");
    });
    const signal = new AbortController().signal;
    const { taskId } = JSON.parse(
      tasks.start({ description: "check", agent: "explorer" }, signal),
    );
    const result = await tasks
      .tools()
      .get("TaskOutput")!
      .execute({ taskId, wait: true }, signal);
    expect(JSON.parse(result.content)).toMatchObject({
      status: reason === "awaiting_user" ? reason : "stopped",
      result: "確認が必要です",
    });
    await tasks.close();
  },
);

it.each([
  { taskId: "foreign" },
  { taskId: "foreign", wait: "yes" },
  { taskId: "foreign", timeoutSec: 61 },
])("rejects foreign or malformed task access %j", async (input) => {
  const s = setup();
  expect(await s.tools.get("TaskOutput")!.validate(input)).toBeTruthy();
  expect(
    await s.tools.get("TaskStop")!.execute(input, s.parent.signal),
  ).toMatchObject({ isError: true });
});
