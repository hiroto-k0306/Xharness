import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { TranscriptItem } from "../../shared/ipc.js";
import { Transcript } from "./Transcript.js";
import { applyEvent, type EventState } from "../state/store.js";

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
it("official mode keeps MCP history readable without reconnect/reset/logout actions", () => {
  const onCommand = vi.fn();
  render(
    <Transcript
      {...props}
      officialDefault
      onCommand={onCommand}
      items={[
        {
          kind: "mcp",
          id: "saved-mcp",
          servers: [
            {
              name: "saved",
              type: "stdio",
              status: "connected",
              tools: 2,
              oauth: true,
            },
          ],
        },
      ]}
    />,
  );
  expect(screen.getByText("saved")).toBeVisible();
  expect(screen.getByText(/ツール 2/)).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("記録は閲覧のみ");
  expect(screen.queryByRole("button", { name: "再接続" })).toBeNull();
  expect(screen.queryByRole("button", { name: "承認を取り消す" })).toBeNull();
  expect(screen.queryByRole("button", { name: "ログアウト" })).toBeNull();
  expect(onCommand).not.toHaveBeenCalled();
});
const command = (
  id: string,
  status: Extract<TranscriptItem, { kind: "tool" }>["status"] = "ok",
): Extract<TranscriptItem, { kind: "tool" }> => ({
  kind: "tool",
  id,
  tool: "Read",
  summary: `Read ${id}.txt`,
  detail: `full input ${id}`,
  status,
});

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

it("recaptures programmatic background focus and removes the trap on unmount", () => {
  const background = document.createElement("textarea");
  document.body.append(background);
  const { unmount } = render(
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
  try {
    const thumb = screen.getByRole("button", { name: "添付画像 1 を拡大" });
    fireEvent.click(thumb);
    background.focus();
    expect(screen.getByRole("button", { name: "閉じる" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(thumb).toHaveFocus();
    background.focus();
    expect(background).toHaveFocus();
    // 再度開いた状態でアンマウントしてもリスナーを残さない。
    fireEvent.click(thumb);
    unmount();
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    try {
      background.focus();
      expect(background).toHaveFocus();
      fireEvent.keyDown(background, { key: "y" });
      expect(behind).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("keydown", behind);
    }
  } finally {
    unmount();
    background.remove();
  }
});

it("clears zoom and releases keyboard capture when the transcript becomes empty", () => {
  const items: TranscriptItem[] = [
    {
      kind: "user",
      id: "u1",
      text: "see",
      images: [{ mediaType: "image/png", data: "AAAA" }],
    },
  ];
  const { rerender } = render(<Transcript {...props} items={items} />);
  fireEvent.click(screen.getByRole("button", { name: "添付画像 1 を拡大" }));
  rerender(<Transcript {...props} items={[]} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  const behind = vi.fn();
  window.addEventListener("keydown", behind);
  try {
    fireEvent.keyDown(document.body, { key: "b", ctrlKey: true });
    expect(behind).toHaveBeenCalledOnce();
    rerender(<Transcript {...props} items={items} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    const thumb = screen.getByRole("button", { name: "添付画像 1 を拡大" });
    thumb.focus();
    expect(thumb).toHaveFocus();
  } finally {
    window.removeEventListener("keydown", behind);
  }
});

it("collapses consecutive commands into one group while retaining individual details", () => {
  const { rerender } = render(
    <Transcript
      {...props}
      items={[
        command("1"),
        command("2", "pending"),
        command("3", "error"),
        command("4", "denied"),
      ]}
    />,
  );
  const group = screen.getByTestId("tool-group");
  const head = group.querySelector("summary")!;
  expect(group).not.toHaveAttribute("open");
  expect(head).toHaveTextContent("コマンド 4 件");
  for (const label of ["running 1", "ok 1", "error 1", "denied 1"])
    expect(head).toHaveTextContent(label);
  const cardHead = screen.getByText("1 Read 1.txt");
  expect(cardHead).not.toBeVisible();
  fireEvent.click(head);
  expect(cardHead).toBeVisible();
  const card = cardHead.closest("details")!;
  expect(card).not.toHaveAttribute("open");
  fireEvent.click(cardHead.closest("summary")!);
  expect(screen.getByText("full input 1")).toBeVisible();
  rerender(
    <Transcript
      {...props}
      items={[
        command("1"),
        command("2"),
        command("3", "error"),
        command("4", "denied"),
        command("5"),
      ]}
    />,
  );
  expect(screen.getByTestId("tool-group")).toBe(group);
  expect(group).toHaveAttribute("open");
  expect(card).toHaveAttribute("open");
  expect(head).toHaveTextContent("コマンド 5 件");
  expect(head).toHaveTextContent("ok 3");
  expect(head).not.toHaveTextContent("running");
  fireEvent.click(head);
  rerender(
    <Transcript
      {...props}
      items={[
        command("1"),
        command("2"),
        command("3"),
        command("4"),
        command("5"),
        command("6"),
      ]}
    />,
  );
  expect(group).not.toHaveAttribute("open");
});

it("retains the manually opened state when a single command becomes a group", () => {
  const { rerender } = render(<Transcript {...props} items={[command("1")]} />);
  const head = screen.getByText("1 Read 1.txt").closest("summary")!;
  const card = head.closest("details")!;
  fireEvent.click(head);
  expect(card).toHaveAttribute("open");
  rerender(<Transcript {...props} items={[command("1"), command("2")]} />);
  expect(screen.getByTestId("tool-group")).toBe(card);
  expect(card).toHaveAttribute("open");
  expect(card.querySelector("summary")).toHaveTextContent("コマンド 2 件");
});

it("breaks command groups at conversation, notices, MCP and dedicated interactive UI", () => {
  const separators: TranscriptItem[] = [
    { kind: "assistant", id: "a", text: "response" },
    { kind: "user", id: "u", text: "request" },
    { kind: "notice", id: "n", tone: "warn", text: "notice" },
    { kind: "mcp", id: "m", servers: [] },
    question,
    {
      ...command("todo"),
      tool: "TodoWrite",
      todos: [{ content: "visible progress", status: "in_progress" }],
    },
  ];
  const items: TranscriptItem[] = [];
  separators.forEach((separator, index) => {
    items.push(command(`${index}a`), command(`${index}b`), separator);
  });
  items.push(command("last"));
  render(<Transcript {...props} items={items} onReply={async () => true} />);
  const groups = screen.getAllByTestId("tool-group");
  expect(groups).toHaveLength(separators.length);
  for (const group of groups) {
    expect(group).not.toHaveAttribute("open");
    expect(group.querySelectorAll("details")).toHaveLength(2);
  }
  expect(screen.getByText("response")).toBeVisible();
  expect(screen.getByText("request")).toBeVisible();
  expect(screen.getByText("# notice")).toBeVisible();
  expect(screen.getByRole("button", { name: "1. 修正する" })).toBeVisible();
  expect(screen.getByText("visible progress")).toBeVisible();
  expect(screen.getByText("last Read last.txt")).toBeVisible();
});

it.each(["dim", "warn"] as const)(
  "renders a %s completion report from the event as an assistant message",
  (tone) => {
    let state: EventState = { app: null, views: {} };
    state = applyEvent(state, {
      type: "text_delta",
      sessionId: "s",
      messageId: "a",
      text: "normal assistant",
    });
    state = applyEvent(state, {
      type: "notice",
      sessionId: "s",
      tone,
      presentation: "assistant",
      message: "完了報告\n- A 完了\n<script>escaped</script>",
    });
    state = applyEvent(state, {
      type: "notice",
      sessionId: "s",
      tone: "warn",
      message: "通常通知",
    });
    render(<Transcript {...props} items={state.views.s!.items} />);
    const report = screen.getByText(/完了報告/);
    const normal = screen.getByText("normal assistant");
    expect(report.textContent).toBe(
      "完了報告\n- A 完了\n<script>escaped</script>",
    );
    expect(report.className).toBe(normal.className);
    expect(report.parentElement!.className).toBe(
      normal.parentElement!.className,
    );
    expect(within(report.parentElement!).getByText("assistant")).toBeVisible();
    expect(screen.getByText("# 通常通知")).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
  },
);

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
