import { expect, it, vi } from "vitest";
const { showMessageBox } = vi.hoisted(() => ({ showMessageBox: vi.fn() }));
vi.mock("electron", () => ({
  BrowserWindow: class {},
  dialog: { showMessageBox },
  ipcMain: { handle: vi.fn() },
}));
import { confirmAuthentication } from "./ipc.js";

it("defaults to cancel and approves only the explicit native allow button", async () => {
  for (const response of [0, -1, 2]) {
    showMessageBox.mockResolvedValueOnce({ response });
    expect(await confirmAuthentication(null, "claude")).toBe(false);
  }
  showMessageBox.mockResolvedValueOnce({ response: 1 });
  expect(await confirmAuthentication(null, "codex")).toBe(true);
  expect(showMessageBox).toHaveBeenLastCalledWith(
    expect.objectContaining({
      defaultId: 0,
      cancelId: 0,
      buttons: ["キャンセル", "許可して認証する"],
      title: "Codex の認証・更新",
    }),
  );
});
