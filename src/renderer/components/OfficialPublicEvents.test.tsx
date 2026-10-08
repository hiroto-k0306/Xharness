import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { OfficialPublicEvents } from "./OfficialPublicEvents.js";
import { communicationInput } from "../../main/workflow/official/communication.js";
afterEach(cleanup);
it("distinguishes actors, parent evidence, truncation, missing bodies and safe text", () => {
  const communication = communicationInput({});
  communication.eventsOmitted = true;
  communication.events = [
    {
      sequence: 1,
      actor: "llm",
      kind: "response",
      parentId: null,
      body: { text: "<script>safe text</script>", truncated: true },
    },
    {
      sequence: 2,
      actor: "tool",
      kind: "tool_result",
      parentId: "parent",
      name: "Read",
    },
    { sequence: 3, actor: "harness", kind: "approval", status: "denied" },
  ];
  const { container } = render(
    <OfficialPublicEvents communication={communication} />,
  );
  expect(screen.getByText(/#1 LLM/)).toBeInTheDocument();
  expect(screen.getByText(/#2 ツール/)).toBeInTheDocument();
  expect(screen.getByText(/#3 ハーネス/)).toBeInTheDocument();
  expect(screen.getByText(/主系列/)).toBeInTheDocument();
  expect(screen.getByText(/親ツールID: parent/)).toBeInTheDocument();
  expect(screen.getByText(/保存上限/)).toBeInTheDocument();
  expect(screen.getByText(/本文は提供されていません/)).toBeInTheDocument();
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("details")?.open).toBe(false);
});
it("does not infer no tools or completion from an old missing event record", () => {
  render(<OfficialPublicEvents />);
  expect(
    screen.getByText(/処理がなかったとは判断しません/),
  ).toBeInTheDocument();
});
