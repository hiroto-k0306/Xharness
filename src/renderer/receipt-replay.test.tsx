import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Receipts } from "./components/Activity.js";
import { ReceiptReplayDialog } from "./components/ReceiptReplay.js";
import { buildReceiptReplay } from "../shared/replay.js";
const values = [0, 1, 2].map((n) => ({
  id: `#${n}`,
  sessionId: "s",
  ts: n * 1000,
  kind: "tool" as const,
  provider: "harness" as const,
  summary: `Read ${n}`,
  tool: "Read",
  input: { path: `a${n}.txt` },
  output: n === 1 ? "<script>globalThis.executed=true</script>" : `result ${n}`,
  durationMs: 1,
  ...(n === 1 ? { agentId: "worker" } : {}),
}));
afterEach(() => vi.useRealTimers());
it("moves forward/back with immutable ownership, raw HTML and no harness commands", () => {
  window.harness = { command: vi.fn(), onEvent: () => () => {} };
  render(
    <ReceiptReplayDialog
      replay={buildReceiptReplay(values)}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText(/1970-01-01T00:00:00.000Z/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("次へ"));
  expect(screen.getByText(/agent worker/)).toBeInTheDocument();
  expect(
    screen.getByText("<script>globalThis.executed=true</script>"),
  ).toBeInTheDocument();
  expect(document.querySelector("script")).toBeNull();
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  expect(screen.getByText("1 / 3")).toBeInTheDocument();
  expect(window.harness.command).not.toHaveBeenCalled();
});
it("takes a snapshot while live receipts grow and closes on Esc without aborting", () => {
  const abort = vi.fn();
  window.addEventListener("keydown", abort);
  const { rerender } = render(<Receipts receipts={values} />);
  fireEvent.click(screen.getByText("再生"));
  rerender(<Receipts receipts={[...values, { ...values[0]!, id: "new" }]} />);
  expect(screen.getByText("1 / 3")).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "レシート再生" })).toBeNull();
  expect(abort).not.toHaveBeenCalled();
  window.removeEventListener("keydown", abort);
});
it("autoplays to the end, stops, and cancels its timer when closed", () => {
  vi.useFakeTimers();
  const { unmount } = render(
    <ReceiptReplayDialog
      replay={buildReceiptReplay(values)}
      onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByText("自動再生"));
  act(() => vi.advanceTimersByTime(500));
  expect(screen.getByText("2 / 3")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(500));
  expect(screen.getByText("3 / 3")).toBeInTheDocument();
  expect(screen.getByText("自動再生")).toBeDisabled();
  fireEvent.click(screen.getByText("前へ"));
  fireEvent.click(screen.getByText("自動再生"));
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
it("handles empty and invalid recordings without adding frames", () => {
  render(
    <ReceiptReplayDialog
      replay={buildReceiptReplay([null])}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText("不正な記録 1 件を除外しました")).toBeInTheDocument();
  expect(screen.getByText("再生できる記録がありません")).toBeInTheDocument();
  expect(screen.getByText("自動再生")).toBeDisabled();
});
