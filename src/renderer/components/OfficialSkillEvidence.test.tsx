import { render, screen, fireEvent } from "@testing-library/react";
import { expect, it } from "vitest";
import type { WorkflowRecord } from "../../main/workflow/official/runtime.js";
import type { OfficialSkillEvidence as Evidence } from "../../shared/official-skills.js";
import { OfficialSkillEvidence } from "./OfficialSkillEvidence.js";

const skill = {
  provider: "claude" as const,
  scope: "project" as const,
  name: "guide",
  source: ".claude/skills/guide/SKILL.md",
  hash: "a".repeat(64),
  bundleHash: "b".repeat(64),
};
function record(evidence: Evidence): WorkflowRecord {
  return {
    version: 1,
    id: "w",
    goal: "fixture",
    cwd: "fixture",
    simulated: true,
    startedAt: "date",
    status: "implementing",
    next: "implement",
    base: "a",
    head: "b",
    correctionRounds: 0,
    tools: [],
    checks: [],
    commits: [],
    reviews: [],
    calls: [
      {
        requestId: "c",
        provider: "claude",
        phase: "implement",
        requestedModel: "claude-opus-5-5",
        effort: "high",
        status: "running",
        officialSkills: evidence,
      },
    ],
  };
}
it("keeps selected and dispatched skills separate from unobserved use", () => {
  render(
    <OfficialSkillEvidence
      record={record({
        requested: [skill],
        dispatched: [{ name: "guide", mechanism: "claude-plugin" }],
      })}
    />,
  );
  fireEvent.click(screen.getByText("公式スキルの送信・使用証跡"));
  expect(screen.getByText("guide · claude-plugin")).toBeInTheDocument();
  expect(screen.getByText("使用は未確認")).toBeInTheDocument();
  expect(
    screen.getByText(
      /選択・実行基盤への送信は、実際に使用した証拠ではありません/,
    ),
  ).toBeInTheDocument();
});
it("shows observed invocation states without turning them into task success", () => {
  const saved = record({
    requested: [skill],
    observed: [
      { name: "guide", status: "requested" },
      { name: "guide", status: "completed" },
    ],
  });
  const before = JSON.stringify(saved);
  render(<OfficialSkillEvidence record={saved} />);
  fireEvent.click(screen.getByText("公式スキルの送信・使用証跡"));
  expect(screen.getByText("guide · 使用要求")).toBeInTheDocument();
  expect(screen.getByText("guide · 呼出完了")).toBeInTheDocument();
  expect(screen.getByText("送信の証跡なし")).toBeInTheDocument();
  expect(
    screen.getByText(/タスク全体の成功を証明しません/),
  ).toBeInTheDocument();
  expect(JSON.stringify(saved)).toBe(before);
});
