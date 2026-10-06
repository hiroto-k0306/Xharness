import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ConnectionPicker } from "./ConnectionPicker.js";
import type { ConnectionView } from "../../shared/connections.js";
const views: ConnectionView[] = [
  {
    mode: "legacy",
    label: "既存方式",
    status: "available",
    reason: "既存設定",
  },
  {
    mode: "openai-siwc",
    label: "OpenAI SIWC",
    status: "unconfigured",
    reason: "専用client IDと認可が未設定",
  },
  {
    mode: "claude-proposals",
    label: "Claude Agent",
    status: "needs_auth",
    reason: "公式SDKで接続確認が必要",
  },
];
it("shows reasons and cancels a draft without applying or starting authentication", () => {
  const command = vi.fn(async () => ({ ok: true }));
  render(
    <ConnectionPicker
      views={views}
      current="legacy"
      disabled={false}
      command={command}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "接続方式: 既存方式" }));
  fireEvent.change(screen.getByRole("combobox", { name: "接続方式" }), {
    target: { value: "openai-siwc" },
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "未設定 — 専用client IDと認可が未設定",
  );
  fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
  expect(command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "接続方式: 既存方式" }));
  expect(screen.getByRole("combobox", { name: "接続方式" })).toHaveValue(
    "legacy",
  );
});
it("applies only the explicit selection, surfaces rejection and supports Escape", async () => {
  const command = vi.fn(async () => ({
    ok: false,
    error: "空のセッションで選択",
  }));
  render(
    <ConnectionPicker
      views={views}
      current="legacy"
      disabled={false}
      command={command}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "接続方式: 既存方式" }));
  fireEvent.change(screen.getByRole("combobox", { name: "接続方式" }), {
    target: { value: "claude-proposals" },
  });
  fireEvent.click(screen.getByRole("button", { name: "接続を適用" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("空のセッションで選択"),
  );
  expect(command).toHaveBeenCalledWith("apply", "claude-proposals");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("cancels an explicit pending SDK check without creating a login request", async () => {
  let finish!: () => void;
  const command = vi.fn((action: string) =>
    action === "check"
      ? new Promise<{ ok: boolean }>((resolve) => {
          finish = () => resolve({ ok: false });
        })
      : Promise.resolve({ ok: true }),
  );
  render(
    <ConnectionPicker
      views={views}
      current="claude-proposals"
      disabled={false}
      command={command}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "接続方式: Claude Agent" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "公式SDK接続を確認" }));
  fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
  expect(command).toHaveBeenCalledWith("cancel", "claude-proposals");
  finish();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("starts SIWC only explicitly and cancels pending authorization when closed", async () => {
  let finish!: (value: { ok: boolean }) => void;
  const accountCommand = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((r) => {
          finish = r;
        }),
    ),
    command = vi.fn(async () => ({ ok: true }));
  render(
    <ConnectionPicker
      views={views}
      current="openai-siwc"
      disabled={false}
      command={command}
      accountCommand={accountCommand}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "接続方式: OpenAI SIWC" }),
  );
  expect(accountCommand).not.toHaveBeenCalled();
  expect(
    screen.getByRole("link", { name: "公式の登録・認可手順" }),
  ).toHaveAttribute(
    "href",
    "https://developers.openai.com/siwc/token-sharing-open-source/sign-in",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Continue with ChatGPT" }),
  );
  expect(accountCommand).toHaveBeenCalledWith("connect", undefined);
  expect(screen.getByRole("button", { name: "接続を適用" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
  expect(command).toHaveBeenCalledWith("cancel", "openai-siwc");
  finish({ ok: false });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
