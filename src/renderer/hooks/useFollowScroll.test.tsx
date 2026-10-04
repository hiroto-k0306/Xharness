import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Transcript } from "../components/Transcript.js";
import { Receipts } from "../components/Activity.js";
import { type TranscriptItem, type Receipt } from "../../shared/ipc.js";

afterEach(() => vi.restoreAllMocks());

it.each(["transcript", "receipt-rows"])(
  "%s follows, pauses on manual scroll, and resumes only at the bottom",
  (panel) => {
    let height = 500;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      () => height,
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
    const items = (n: number): TranscriptItem[] => [
      { kind: "assistant", id: "a", text: "output".repeat(n) },
    ];
    const receipts = (n: number): Receipt[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `#${i}`,
        sessionId: "s",
        ts: i,
        provider: "harness",
        kind: "tool",
        durationMs: 1,
        summary: "Read",
      }));
    const element = (n: number, sessionId = "s") =>
      panel === "transcript" ? (
        <Transcript key={sessionId} items={items(n)} running model="fake" />
      ) : (
        <Receipts sessionId={sessionId} receipts={receipts(n)} />
      );
    const view = render(element(1));
    const pane = screen.getByTestId(panel);
    expect(pane.scrollTop).toBe(400);
    pane.scrollLeft = 30;
    height = 600;
    view.rerender(element(2));
    expect(pane.scrollTop).toBe(500);
    expect(pane.scrollLeft).toBe(30);
    pane.scrollTop = 200;
    fireEvent.scroll(pane);
    height = 700;
    view.rerender(element(3));
    expect(pane.scrollTop).toBe(200);
    pane.scrollTop = 599;
    fireEvent.scroll(pane);
    height = 800;
    view.rerender(element(4));
    expect(pane.scrollTop).toBe(700);
    fireEvent.wheel(pane, { deltaY: -50 });
    height = 900;
    view.rerender(element(5));
    expect(pane.scrollTop).toBe(700);
    view.rerender(element(6, "other-session"));
    expect(screen.getByTestId(panel).scrollTop).toBe(800);
  },
);

it("tracks late layout growth but not while reading older output, and disconnects observers", () => {
  let resized!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    },
  );
  let height = 500;
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    () => height,
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
  try {
    const view = render(<Transcript items={[]} running={false} model="fake" />);
    view.rerender(
      <Transcript
        items={[{ kind: "assistant", id: "a", text: "late image" }]}
        running
        model="fake"
      />,
    );
    const pane = screen.getByTestId("transcript");
    height = 600;
    act(() => resized());
    expect(pane.scrollTop).toBe(500);
    pane.scrollTop = 100;
    fireEvent.scroll(pane);
    height = 700;
    act(() => resized());
    expect(pane.scrollTop).toBe(100);
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
