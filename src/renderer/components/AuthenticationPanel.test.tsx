import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AuthenticationPanel } from "./AuthenticationPanel.js";

it("asks for auth consent for missing/expired providers without launching anything on mount", async () => {
  const command = vi.fn(async () => ({ ok: true }));
  render(
    <AuthenticationPanel
      views={[
        { provider: "claude", status: "expired" },
        { provider: "codex", status: "available" },
      ]}
      disabled={false}
      command={command}
    />,
  );
  expect(screen.getByText("Claude · 期限切れ")).toBeInTheDocument();
  expect(screen.getByText("Codex · 資格情報あり")).toBeInTheDocument();
  expect(command).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Codexの認証・更新を許可" }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Claudeの認証・更新を許可" }),
  );
  await waitFor(() =>
    expect(command).toHaveBeenCalledWith("authenticate", "claude"),
  );
});
it("disables login while a session is active and allows explicit status refresh", async () => {
  const command = vi.fn(async () => ({ ok: false, error: "再確認エラー" }));
  const { rerender } = render(
    <AuthenticationPanel
      views={[{ provider: "claude", status: "missing" }]}
      disabled
      command={command}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Claudeの認証・更新を許可" }),
  ).toBeDisabled();
  rerender(
    <AuthenticationPanel
      views={[{ provider: "claude", status: "missing" }]}
      disabled={false}
      command={command}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "状態を再確認" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("再確認エラー"),
  );
  expect(command).toHaveBeenCalledWith("refresh_auth", undefined);
});
