import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { OfficialCommunication } from "./OfficialCommunication.js";
import type { WorkflowRecord } from "../../main/workflow/official/runtime.js";
afterEach(cleanup);
it("shows numbered inputs/results, omission and legacy gaps without executing HTML", () => {
  const record = {
    calls: [
      {
        requestId: "new",
        phase: "review",
        provider: "codex",
        requestedModel: "luna",
        status: "running",
        communication: {
          boundary: "xharness-official-agent",
          input: { text: "<script>data</script>", truncated: true },
        },
      },
      {
        requestId: "old",
        phase: "plan",
        provider: "claude",
        requestedModel: "opus",
        status: "completed",
      },
    ],
  } as WorkflowRecord;
  const { container } = render(<OfficialCommunication record={record} />);
  expect(screen.getByText(/#1/)).toHaveTextContent("別会社");
  expect(screen.getByText(/保存上限/)).toBeInTheDocument();
  expect(screen.getByText(/応答本文は未取得/)).toBeInTheDocument();
  expect(screen.getByText(/過去の内容は補完/)).toBeInTheDocument();
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelectorAll("details")).toHaveLength(2);
  expect(container.querySelector("details")?.open).toBe(false);
});
