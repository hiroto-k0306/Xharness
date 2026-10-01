import { describe, expect, it } from "vitest";
import { loadModelCatalog } from "../config/model-catalog.js";
import { type PlanItem, validatePlan } from "./plan-validate.js";

const catalog = loadModelCatalog();
const item = (id: string, override: Partial<PlanItem> = {}): PlanItem => ({
  id,
  title: "型を追加",
  instructions: "指定した型を追加してテストしてください",
  files: [`src/${id}.ts`],
  dependsOn: [],
  assignee: {
    agent: "worker",
    model: "codex:sol",
    effort: "high",
    reason: "独立した型定義",
  },
  acceptance: "型検査が通る",
  ...override,
});
const validate = (items: unknown) => validatePlan(items, catalog);

describe("SubmitPlan validation", () => {
  it("accepts enabled models and leaves the submitted plan unchanged", () => {
    const plan = [item("P1"), item("P2", { dependsOn: ["P1"] })];
    const original = structuredClone(plan);
    expect(validate(plan)).toEqual({ errors: [], warnings: [] });
    expect(plan).toEqual(original);
  });
  it.each([
    null,
    [],
    [{}],
    [item("P1", { files: [3] as unknown as string[] })],
  ])("rejects malformed input %j", (input) => {
    expect(validate(input).errors.length).toBeGreaterThan(0);
  });
  it("rejects duplicate IDs and unknown dependencies", () => {
    expect(validate([item("P1"), item("P1")]).errors.join()).toContain("重複");
    expect(
      validate([item("P1", { dependsOn: ["missing"] })]).errors.join(),
    ).toContain("存在しない");
  });
  it("rejects self-dependency and indirect cycles", () => {
    expect(
      validate([item("P1", { dependsOn: ["P1"] })]).errors.join(),
    ).toContain("循環");
    expect(
      validate([
        item("P1", { dependsOn: ["P2"] }),
        item("P2", { dependsOn: ["P3"] }),
        item("P3", { dependsOn: ["P1"] }),
      ]).errors.join(),
    ).toContain("循環");
  });
  it("rejects unknown and disabled models", () => {
    for (const model of [
      "codex:missing",
      "claude:gpt-6.1-sol",
      "claude:claude-fable-5-1",
    ])
      expect(
        validate([
          item("P1", { assignee: { ...item("P1").assignee, model } }),
        ]).errors.join(),
      ).toContain("有効");
  });
  it("validates effort against the catalog and rejects ultra", () => {
    const limited = catalog.map((model) => ({
      ...model,
      efforts: { low: "low" as const },
    }));
    expect(validatePlan([item("P1")], limited).errors.join()).toContain(
      "effort",
    );
    expect(
      validate([
        item("P1", {
          assignee: { ...item("P1").assignee, effort: "ultra" as never },
        }),
      ]).errors.length,
    ).toBeGreaterThan(0);
  });
  it("accepts Haiku assignment metadata without inventing a wire effort", () => {
    expect(
      validate([
        item("P1", {
          assignee: {
            ...item("P1").assignee,
            model: "claude:haiku",
            effort: "low",
          },
        }),
      ]).errors,
    ).toEqual([]);
  });
  it.each([
    "../secret",
    "src/../secret",
    "D:\\secret",
    "\\\\server\\secret",
    "/secret",
    "src/a:stream",
    "src/\u0000a",
  ])("rejects unsafe path %s", (path) => {
    expect(validate([item("P1", { files: [path] })]).errors.join()).toContain(
      "相対パス",
    );
  });
  it.each([
    ["src/*.ts", "src/a.ts"],
    ["src/**", "src/deep/a.ts"],
    ["SRC/A.ts", "src\\a.ts"],
    ["src/{a,b}.ts", "src/a.ts"],
  ])("serializes overlapping Windows files %s / %s", (a, b) => {
    expect(
      validate([
        item("P1", { files: [a] }),
        item("P2", { files: [b] }),
      ]).errors.join(),
    ).toContain("直列");
  });
  it("permits disjoint directories and transitive serialized overlap", () => {
    expect(
      validate([
        item("P1", { files: ["src/a/**"] }),
        item("P2", { files: ["src/b/**"] }),
      ]).errors,
    ).toEqual([]);
    expect(
      validate([
        item("P1"),
        item("P2", { dependsOn: ["P1"] }),
        item("P3", { files: ["src/P1.ts"], dependsOn: ["P2"] }),
      ]).errors,
    ).toEqual([]);
  });
  it("warns for known usage over 90%, without blocking or treating unknown as exhausted", () => {
    expect(
      validatePlan([item("P1")], catalog, {
        fiveHourUsedPercent: { codex: 91 },
      }),
    ).toMatchObject({
      errors: [],
      warnings: [expect.stringContaining("5時間枠")],
    });
    expect(
      validatePlan([item("P1")], catalog, {
        fiveHourUsedPercent: { codex: 90 },
      }).warnings,
    ).toEqual([]);
    expect(validate([item("P1")]).warnings).toEqual([]);
  });
  it("honors configured aliases while still checking provider and enabled state", () => {
    expect(
      validatePlan(
        [
          item("P1", {
            assignee: { ...item("P1").assignee, model: "codex:custom" },
          }),
        ],
        catalog,
        { aliases: { custom: "gpt-6.1-sol" } },
      ).errors,
    ).toEqual([]);
  });
});
