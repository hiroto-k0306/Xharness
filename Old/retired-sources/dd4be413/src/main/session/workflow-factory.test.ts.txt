import { expect, it } from "vitest";
import { workflowNotice } from "./workflow-factory.js";

it("reports completed items when the workflow completes", () => {
  const text = workflowNotice({
    phase: "complete",
    reviewRound: 1,
    items: [
      {
        id: "A",
        title: "文字の送り切り",
        agent: "worker",
        model: "claude-sonnet-5-5",
        status: "integrated",
      },
      { id: "B", status: "integrated" },
    ],
    findings: [],
  });
  expect(text.split("\n")).toEqual([
    "ワークフローが完了しました。レビューで修正対象（must / should）の指摘はありません。",
    "- A 文字の送り切り（worker · claude-sonnet-5-5）: integrated",
    "- B （worker · ）: integrated",
  ]);
});

it.each(["must", "should"] as const)(
  "lists remaining %s findings when the review round limit is reached",
  (severity) => {
    const text = workflowNotice({
      phase: "attention",
      reviewRound: 3,
      items: [{ id: "A", title: "x", status: "integrated" }],
      findings: [{ severity, file: "src/a.ts", line: 3, message: "直す" }],
    });
    expect(text).toContain(
      "レビューの往復上限に達しました。残る修正対象（must / should）の指摘を確認してください。",
    );
    expect(text).toContain("\n- A x（worker · ）: integrated");
    expect(text).toContain(`\n${severity}: src/a.ts:3 — 直す`);
  },
);
