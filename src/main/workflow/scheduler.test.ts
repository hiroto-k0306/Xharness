import { expect, it } from "vitest";
import { loadModelCatalog } from "../config/model-catalog.js";
import { type PlanItem } from "./plan-validate.js";
import { SerialScheduler } from "./scheduler.js";

const catalog = loadModelCatalog();
const item = (id: string, dependsOn: string[] = []): PlanItem => ({
  id,
  title: id,
  instructions: "実装",
  files: [`${id}.ts`],
  dependsOn,
  assignee: {
    agent: "worker",
    model: "codex:sol",
    effort: "high",
    reason: "独立した実装",
  },
  acceptance: "テストが通る",
});

it("orders by dependencies and holds the sole slot until integration", () => {
  const scheduler = new SerialScheduler(
    [item("P2", ["P1"]), item("P1")],
    catalog,
  );
  expect(scheduler.startNext()?.id).toBe("P1");
  expect(scheduler.startNext()).toBeUndefined();
  scheduler.integrated("P1");
  expect(scheduler.startNext()?.id).toBe("P2");
  scheduler.integrated("P2");
  expect(scheduler.startNext()).toBeUndefined();
  expect(
    scheduler.snapshot().every((entry) => entry.status === "integrated"),
  ).toBe(true);
});
it("pauses on integration failure and permits an explicit retry", () => {
  const scheduler = new SerialScheduler(
    [item("P1"), item("P2", ["P1"])],
    catalog,
  );
  scheduler.startNext();
  scheduler.fail("P1");
  expect(scheduler.startNext()).toBeUndefined();
  scheduler.retry("P1");
  expect(scheduler.startNext()?.id).toBe("P1");
  scheduler.integrated("P1");
  expect(scheduler.startNext()?.id).toBe("P2");
});
it("preserves main assignments and isolates mutable inputs and snapshots", () => {
  const plan = [item("P1")];
  plan[0]!.assignee.agent = "main";
  const scheduler = new SerialScheduler(plan, catalog);
  plan[0]!.dependsOn.push("missing");
  const dispatched = scheduler.startNext()!;
  expect(dispatched.assignee.agent).toBe("main");
  dispatched.id = "changed";
  scheduler.snapshot()[0]!.status = "failed";
  scheduler.integrated("P1");
  expect(scheduler.snapshot()).toEqual([{ id: "P1", status: "integrated" }]);
});
it("rejects invalid plans and impossible state transitions", () => {
  expect(() => new SerialScheduler([item("P1", ["P1"])], catalog)).toThrow(
    "循環",
  );
  const scheduler = new SerialScheduler([item("P1")], catalog);
  expect(() => scheduler.integrated("P1")).toThrow("実行状態");
  expect(() => scheduler.fail("unknown")).toThrow("実行状態");
  expect(() => scheduler.retry("P1")).toThrow("失敗状態");
  scheduler.startNext();
  scheduler.integrated("P1");
  expect(() => scheduler.integrated("P1")).toThrow("実行状態");
});
