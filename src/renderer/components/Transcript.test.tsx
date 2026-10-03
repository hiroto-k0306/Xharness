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

it("renders generic tool cards closed and opens the full input on click", () => {
  const detail = '<b>x</b>\n{\n  "path": "a.txt"\n}';
  render(
    <Transcript
      {...props}
      items={[
        {
          kind: "tool",
          id: "#0001",
          tool: "Read",
          summary: "Read a.txt",
          detail,
          status: "ok",
        },
      ]}
    />,
  );
  const card = document.querySelector("details[data-status='ok']")!;
  expect(card).not.toBeNull();
  expect(card).not.toHaveAttribute("open");
  const summary = screen.getByText("#0001 Read a.txt").closest("summary")!;
  expect(summary).toHaveTextContent("✓ ok");
  fireEvent.click(summary);
  expect(card).toHaveAttribute("open");
  const pre = card.querySelector("pre")!;
  expect(pre.textContent).toBe(detail);
  expect(card.querySelector("b")).toBeNull();
  fireEvent.click(summary);
  expect(card).not.toHaveAttribute("open");
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

it("opens an attached image enlarged and closes with Esc, backdrop and button", () => {
  const items: TranscriptItem[] = [
    {
      kind: "user",
      id: "u1",
      text: "see",
      images: [{ mediaType: "image/png", data: "AAAA" }],
    },
  ];
  render(<Transcript {...props} items={items} />);
  const open = () =>
    fireEvent.click(screen.getByRole("button", { name: "添付画像 1 を拡大" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  open();
  const dialog = screen.getByRole("dialog", { name: "画像の拡大表示" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  fireEvent.click(screen.getByAltText("拡大した添付画像"));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  // 実行中の Esc 中断(App の window の keydown)へは伝えない
  const appEscape = vi.fn();
  window.addEventListener("keydown", appEscape);
  fireEvent.keyDown(document.body, { key: "Escape" });
  window.removeEventListener("keydown", appEscape);
  expect(appEscape).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  open();
  fireEvent.click(screen.getByRole("dialog"));
  expect(screen.queryByRole("dialog")).toBeNull();
  open();
  fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps keyboard focus inside the enlarged image and restores it on close", () => {
  render(
    <Transcript
      {...props}
      items={[
        {
          kind: "user",
          id: "u1",
          text: "see",
          images: [{ mediaType: "image/png", data: "AAAA" }],
        },
      ]}
    />,
  );
  const thumb = screen.getByRole("button", { name: "添付画像 1 を拡大" });
  thumb.focus();
  fireEvent.click(thumb);
  const close = screen.getByRole("button", { name: "閉じる" });
  expect(close).toHaveFocus();
  // Tab でも背後へ出ない
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(close).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
  expect(close).toHaveFocus();
  // 承認の y などの背後のショートカットへ伝えない
  const behind = vi.fn();
  window.addEventListener("keydown", behind);
  fireEvent.keyDown(document.activeElement!, { key: "y" });
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  window.removeEventListener("keydown", behind);
  expect(behind).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(thumb).toHaveFocus();
});

it("keeps line breaks of multi-line notices", () => {
  render(
    <Transcript
      {...props}
      items={[
        {
          kind: "notice",
          id: "n1",
          tone: "dim",
          text: "ワークフローが完了しました。\n- A 項目1\n- B 項目2",
        },
      ]}
    />,
  );
  expect(screen.getByText(/ワークフローが完了しました/).textContent).toBe(
    "# ワークフローが完了しました。\n- A 項目1\n- B 項目2",
  );
});
