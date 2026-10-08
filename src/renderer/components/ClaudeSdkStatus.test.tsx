import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ClaudeSdkStatus } from "./ClaudeSdkStatus.js";
it("shows selected version, candidate, last check and a failed update without calling a provider", () => {
  const { rerender } = render(<ClaudeSdkStatus />);
  expect(screen.queryByText("Claude SDK")).toBeNull();
  rerender(
    <ClaudeSdkStatus
      runtime={{
        version: "0.3.290",
        candidate: "0.4.0",
        checkedAt: "2026-10-08T00:00:00Z",
        state: "attention",
        message: "互換範囲外です。現在の版を維持します。",
        root: "D:/test/runtime",
      }}
    />,
  );
  expect(screen.getByText(/次のタスクで使う版：0.3.290/)).toBeDefined();
  expect(screen.getByText(/更新候補：0.4.0/)).toBeDefined();
  expect(screen.getByRole("alert").textContent).toContain("現在の版を維持");
});
