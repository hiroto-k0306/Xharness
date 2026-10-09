import { expect, it } from "vitest";
import {
  parseImprovementAction,
  validCases,
  validSource,
} from "./improvements.js";
const task = {
  id: "one",
  prompt: "ping",
  taskType: "text",
  difficulty: "small",
  criteria: "v1",
  environment: "fixed",
};
it("requires a bounded fixed selection, snapshot and explicit confirmation for model candidates", () => {
  const query = {
    action: "model_candidates",
    id: "comparison",
    revision: 1,
    versionId: "baseline",
    caseId: "one",
  };
  expect(parseImprovementAction(query)).toBeDefined();
  expect(parseImprovementAction({ ...query, revision: 0 })).toBeUndefined();
  const selection = {
    ...query,
    action: "select_model_candidate",
    candidateId: "claude/model/high",
    snapshot: "a".repeat(64),
    reason: "manual",
  };
  expect(parseImprovementAction(selection)).toBeUndefined();
  expect(
    parseImprovementAction({ ...selection, confirmed: "true" }),
  ).toBeUndefined();
  expect(
    parseImprovementAction({ ...selection, confirmed: true }),
  ).toBeDefined();
  expect(
    parseImprovementAction({ ...selection, confirmed: true, snapshot: "old" }),
  ).toBeUndefined();
  expect(
    parseImprovementAction({ ...selection, confirmed: true, reason: "" }),
  ).toBeUndefined();
});
it("requires bounded fixed conditions and rejects hidden source/condition fields", () => {
  expect(validCases([task])).toBe(true);
  expect(validCases([task, task])).toBe(false);
  expect(validCases([{ ...task, system: "override" }])).toBe(false);
  expect(validCases([{ ...task, prompt: "a".repeat(4001) }])).toBe(false);
  expect(
    validSource({ skill: { source: "../SKILL.md", hash: "a".repeat(64) } }),
  ).toBe(false);
  expect(
    validSource({ memory: { id: "memory", revision: 1, token: "hidden" } }),
  ).toBe(false);
});
it("requires explicit confirmed acceptance and quality evidence, never coerces string booleans", () => {
  const acceptance = {
    action: "adopt",
    id: "one",
    revision: 1,
    versionId: "baseline",
    reason: "reviewed",
  };
  expect(parseImprovementAction(acceptance)).toBeUndefined();
  expect(
    parseImprovementAction({ ...acceptance, confirmed: true }),
  ).toBeDefined();
  const record = {
    action: "record",
    id: "one",
    revision: 1,
    versionId: "baseline",
    caseId: "one",
    sessionId: "current",
    taskId: "current",
    passed: "true",
    evidence: "",
  };
  expect(parseImprovementAction(record)).toBeUndefined();
  expect(
    parseImprovementAction({
      ...record,
      passed: true,
      evidence: "User reviewed saved output",
    }),
  ).toBeDefined();
});
