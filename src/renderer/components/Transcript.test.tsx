import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { TranscriptItem } from "../../shared/ipc.js";
import { Transcript } from "./Transcript.js";

const question: TranscriptItem = {
  kind: "tool",
  id: "q1",
  tool: "AskUserQuestion",
  summary: "AskUserQuestion",
  status: "ok",
  question: {
    question: "どちらで進めますか？",
    options: ["修正する", "調査する"],
  },
};
const props = { items: [question], running: false, model: "fake" };

it("sends the option text once and locks all choices until the next turn", async () => {
  let resolve!: (ok: boolean) => void;
  const onReply = vi.fn(
    () =>
      new Promise<boolean>((r) => {
        resolve = r;
      }),
  );
  render(<Transcript {...props} onReply={onReply} />);
  const button = screen.getByRole("button", { name: "1. 修正する" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(onReply).toHaveBeenCalledExactlyOnceWith("修正する");
  expect(screen.getByRole("button", { name: "2. 調査する" })).toBeDisabled();
  await act(async () => resolve(true));
  expect(button).toBeDisabled();
});

it.each([false, "throw"])(
  "allows retry when sending fails (%s)",
  async (result) => {
    const onReply = vi.fn(async () => {
      if (result === "throw") throw new Error("offline");
      return false;
    });
    render(<Transcript {...props} onReply={onReply} />);
    const button = screen.getByRole("button", { name: "1. 修正する" });
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "回答を送信できませんでした",
    );
    expect(button).toBeEnabled();
  },
);

it("disables answered and superseded questions, running and blocked sessions, and history without a reply target", () => {
  const onReply = vi.fn(async () => true);
  const { rerender } = render(<Transcript {...props} onReply={onReply} />);
  for (const extra of [
    { running: true },
    { blocked: true },
    { onReply: undefined },
    { items: [question, { kind: "user" as const, id: "u", text: "2" }] },
    { items: [question, { ...question, id: "q2", status: "error" as const }] },
    { items: [question, { ...question, id: "s", tool: "StopTask" }] },
  ]) {
    rerender(<Transcript {...props} onReply={onReply} {...extra} />);
    const button = screen.getByRole("button", { name: "1. 修正する" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
  }
  expect(onReply).not.toHaveBeenCalled();
});

it.each(["pending", "error", "denied"] as const)(
  "does not show choices for a %s call",
  (status) => {
    render(<Transcript {...props} items={[{ ...question, status }]} />);
    expect(screen.queryByRole("button")).toBeNull();
  },
);

it("escapes model text and preserves manual entry for questions without choices", async () => {
  const { rerender } = render(
    <Transcript
      {...props}
      items={[
        {
          ...question,
          question: {
            question: "<script>question</script>",
            options: ["<img src=x>", "別案"],
          },
        },
      ]}
      onReply={async () => true}
    />,
  );
  expect(screen.getByRole("button", { name: "1. <img src=x>" })).toBeEnabled();
  expect(document.querySelector("script, img")).toBeNull();
  rerender(
    <Transcript {...props} items={[{ ...question, question: undefined }]} />,
  );
  await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
});
