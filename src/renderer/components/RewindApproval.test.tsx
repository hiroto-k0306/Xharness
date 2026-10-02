import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RewindApproval } from "./RewindApproval.js";

const preview = {
  turns: 2,
  files: [
    { id: "a", path: "a.ts", conflict: false },
    { id: "b", path: "b.ts", conflict: true },
    { id: "c", path: "c.ts", conflict: true, unavailable: "10 MB超" },
  ],
};
it("defaults to code with conflicts excluded and requires confirmation", () => {
  const respond = vi.fn();
  render(<RewindApproval preview={preview} onRespond={respond} />);
  expect(screen.getByLabelText("復元対象")).toHaveValue("code");
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(respond).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("確認して復元"));
  expect(respond).toHaveBeenCalledWith({ scope: "code", includeConflicts: [] });
});
it("allows explicit conflict override, disables it for conversation, and supports cancellation", () => {
  const respond = vi.fn();
  const { unmount } = render(
    <RewindApproval preview={preview} onRespond={respond} />,
  );
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByLabelText("復元対象"), {
    target: { value: "conversation" },
  });
  expect(screen.getByRole("checkbox")).toBeDisabled();
  fireEvent.click(screen.getByText("確認して復元"));
  expect(respond).toHaveBeenCalledWith({
    scope: "conversation",
    includeConflicts: [],
  });
  unmount();
  render(<RewindApproval preview={preview} onRespond={respond} />);
  fireEvent.click(screen.getByText("キャンセル"));
  expect(respond).toHaveBeenLastCalledWith(null);
});
