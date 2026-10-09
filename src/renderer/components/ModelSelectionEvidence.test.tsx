import { render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { WorkflowRecord } from "../../main/workflow/official/runtime.js";
import { ModelSelectionEvidence } from "./ModelSelectionEvidence.js";
import { setUiModelCatalog } from "../state/model-catalog.js";

const catalog = { version: 2, updatedAt: "2026-10-10", digest: "b".repeat(64) };
const call: WorkflowRecord["calls"][number] = {
  requestId: "call",
  provider: "codex",
  phase: "implement",
  requestedModel: "gpt-call-id",
  effort: "high",
  status: "running",
};
function record(calls: WorkflowRecord["calls"]): WorkflowRecord {
  return {
    version: 1,
    id: "work",
    goal: "fixture",
    cwd: "fixture",
    simulated: true,
    startedAt: "2026-10-09",
    status: "implementing",
    next: "implement",
    base: "a",
    head: "b",
    correctionRounds: 0,
    calls,
    tools: [],
    commits: [],
    checks: [],
    reviews: [],
  };
}
afterEach(() => setUiModelCatalog(undefined));

it("shows the saved alias, resolved ID, effort and catalog change without consulting today's catalog", () => {
  setUiModelCatalog([
    { id: "gpt-future", alias: "sol", provider: "codex", efforts: [] },
  ]);
  const saved = record([
    {
      ...call,
      modelSelection: {
        policy: { provider: "codex", model: "sol", effort: "high" },
        resolved: {
          provider: "codex",
          model: "gpt-call-id",
          effort: "high",
          catalog,
        },
        previous: {
          model: "gpt-previous",
          effort: "high",
          catalog: { ...catalog, version: 1, digest: "a".repeat(64) },
        },
        changed: true,
      },
    },
  ]);
  const before = JSON.stringify(saved);
  render(<ModelSelectionEvidence record={saved} />);
  expect(screen.getByText(/保存policy：codex:sol/)).toHaveTextContent(
    "effort：high",
  );
  expect(
    screen.getByText(/呼出時の実ID：codex\/gpt-call-id/),
  ).toBeInTheDocument();
  expect(screen.getByText(/catalog：v2/)).toHaveTextContent(catalog.digest);
  expect(screen.getByText(/前回の実ID：gpt-previous/)).toHaveTextContent(
    "catalog：v1",
  );
  expect(screen.getByText("前回との変更：あり")).toBeInTheDocument();
  expect(screen.queryByText(/gpt-future/)).not.toBeInTheDocument();
  expect(JSON.stringify(saved)).toBe(before);
});

it("keeps historical IDs and missing policy evidence without inventing a current alias", () => {
  render(<ModelSelectionEvidence record={record([call])} />);
  expect(
    screen.getByText(/当時の指定ID：codex\/gpt-call-id/),
  ).toHaveTextContent("alias policy・catalogの保存記録なし");
  expect(screen.queryByText(/保存policy/)).not.toBeInTheDocument();
});
