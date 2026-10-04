import { expect, it } from "vitest";
import { WorkflowState, type ReviewFinding } from "./state.js";

const finding = (severity: ReviewFinding["severity"]): ReviewFinding => ({
  severity,
  file: "fix.ts",
  message: "Review finding",
});

it.each(["must", "should"] as const)(
  "%s requires correction and stops at the configured review limit",
  (severity) => {
    const state = new WorkflowState("auto", 2);
    state.approve();
    state.requestReview(true, true);
    state.reviewed([finding("nit"), finding(severity)]);
    expect(state.phase).toBe("implement");
    expect(state.reviewRound).toBe(1);
    state.requestReview(true, true);
    state.reviewed([finding(severity)]);
    expect(state.phase).toBe("attention");
    expect(state.reviewRound).toBe(2);
  },
);

it.each([{ result: [] }, { result: [finding("nit")] }])(
  "completes with no must or should findings: %j",
  ({ result }) => {
    const state = new WorkflowState("always", 1);
    state.approve();
    state.requestReview(true, true);
    state.reviewed(result);
    expect(state.phase).toBe("complete");
  },
);

it("completes after correcting should even on the last review round", () => {
  const state = new WorkflowState("auto", 2);
  state.approve();
  state.requestReview(true, true);
  state.reviewed([finding("should")]);
  state.requestReview(true, true);
  state.reviewed([finding("nit")]);
  expect(state.phase).toBe("complete");
  expect(state.findings).toEqual([finding("nit")]);
});
