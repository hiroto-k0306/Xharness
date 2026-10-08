import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CodexRuntimeSettings } from "./CodexRuntimeSettings.js";
it("shows a fixed override and requires an explicit action to restore auto discovery", () => {
  const send = vi.fn(async () => {});
  const { rerender } = render(
    <CodexRuntimeSettings
      disabled={false}
      send={send}
      connection={{
        codexPath: "C:/old/codex.exe",
        codexMode: "fixed",
        workspaceRoot: "",
        status: "unconfigured",
        message: "指定版が見つかりません",
      }}
    />,
  );
  expect(screen.getByText("Codex：指定版を固定")).toBeDefined();
  expect(send).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("公式Codex実行パス"), {
    target: { value: "C:/chosen" },
  });
  fireEvent.click(screen.getByText("公式接続設定を保存"));
  expect(send).toHaveBeenLastCalledWith({
    action: "configure",
    codexPath: "C:/chosen",
  });
  fireEvent.click(screen.getByText("同梱版の自動追従に戻す"));
  expect(send).toHaveBeenLastCalledWith({ action: "configure_auto" });
  rerender(
    <CodexRuntimeSettings disabled send={send} connection={undefined} />,
  );
  send.mockClear();
  fireEvent.click(screen.getByText("同梱版の自動追従に戻す"));
  fireEvent.click(screen.getByText("公式接続設定を保存"));
  expect(send).not.toHaveBeenCalled();
});
