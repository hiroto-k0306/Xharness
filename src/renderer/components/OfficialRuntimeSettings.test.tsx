import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  OfficialWorkflowCommand,
  OfficialWorkflowView,
} from "../../shared/official-workflow.js";
import { OfficialRuntimeSettings } from "./OfficialRuntimeSettings.js";
import { OfficialWorkflowPanel } from "./OfficialWorkflowPanel.js";
afterEach(() => vi.unstubAllGlobals());
it("runtime settings preserve configure and auto controls and explain Windows notifications", async () => {
  const view: OfficialWorkflowView = {
    available: true,
    simulated: false,
    records: [],
    connection: {
      codexPath: "C:/Codex/codex.exe",
      workspaceRoot: "",
      status: "configured",
      message: "Saved connection",
      codexMode: "fixed",
    },
  };
  const api = vi.fn(async (c: OfficialWorkflowCommand) => {
    void c;
    return view;
  });
  vi.stubGlobal("harness", { officialWorkflow: api });
  render(<OfficialRuntimeSettings />);
  await screen.findByText("参照先：C:/Codex/codex.exe");
  fireEvent.change(screen.getByRole("textbox", { name: "公式Codex実行パス" }), {
    target: { value: "C:/Other/codex.exe" },
  });
  fireEvent.click(screen.getByRole("button", { name: "公式接続設定を保存" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith({
      action: "configure",
      codexPath: "C:/Other/codex.exe",
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "同梱版の自動追従に戻す" }),
    ).toBeEnabled(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "同梱版の自動追従に戻す" }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith({ action: "configure_auto" }),
  );
  expect(screen.getByText(/Windowsの設定/)).toHaveTextContent(
    "アプリは通知設定を変更しません",
  );
  expect(
    screen.queryByRole("button", { name: "公式workflow" }),
  ).not.toBeInTheDocument();
});
it("normal UI has no standalone workflow panel entry while verification preserves it", async () => {
  let view: OfficialWorkflowView = {
    available: true,
    simulated: false,
    records: [],
  };
  const api = vi.fn(async () => view);
  vi.stubGlobal("harness", { officialWorkflow: api });
  const { unmount } = render(<OfficialWorkflowPanel verificationOnly />);
  await waitFor(() => expect(api).toHaveBeenCalled());
  expect(
    screen.queryByRole("button", { name: "公式workflow" }),
  ).not.toBeInTheDocument();
  unmount();
  view = { ...view, verification: "fix-cycle-v1" };
  render(<OfficialWorkflowPanel verificationOnly />);
  expect(
    await screen.findByRole("button", { name: "公式workflow" }),
  ).toBeInTheDocument();
});
