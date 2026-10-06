import { it, expect, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { OfficialWorkflowService } from "./workflow/official/service.js";
const mock = vi.hoisted(() => ({
  handler: undefined as
    undefined | ((event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (_channel: string, handler: typeof mock.handler) => {
      mock.handler = handler;
    },
  },
}));
import { registerOfficialWorkflowIpc } from "./official-workflow-ipc.js";
it("rejects foreign frames and arbitrary workflow input before invoking the service", async () => {
  const webContents = { mainFrame: {} },
    window = {
      webContents,
      isDestroyed: () => false,
    } as unknown as BrowserWindow;
  const command = vi.fn(async () => ({}));
  registerOfficialWorkflowIpc(() => window, {
    command,
  } as unknown as OfficialWorkflowService);
  const event = {
    sender: webContents,
    senderFrame: webContents.mainFrame,
  } as unknown as IpcMainInvokeEvent;
  await expect(
    mock.handler!({ ...event, senderFrame: {} } as IpcMainInvokeEvent, {
      action: "create",
      provider: "claude",
    }),
  ).rejects.toThrow("origin rejected");
  await expect(
    mock.handler!(event, {
      action: "create",
      provider: "claude",
      cwd: "C:/outside",
    }),
  ).rejects.toThrow("Invalid workflow command");
  await expect(
    mock.handler!(event, { action: "approve", id: "not-id", digest: "fake" }),
  ).rejects.toThrow("Invalid workflow command");
  expect(command).not.toHaveBeenCalled();
  await expect(
    mock.handler!(event, {
      action: "workspace_root",
      path: "D:/x",
      createIfMissing: true,
    }),
  ).rejects.toThrow("Invalid workflow command");
  await expect(
    mock.handler!(event, { action: "workspace_root", path: "x".repeat(1001) }),
  ).rejects.toThrow("Invalid workflow command");
  expect(command).not.toHaveBeenCalled();
  await mock.handler!(event, { action: "list" });
  expect(command).toHaveBeenCalledWith({ action: "list" });
  await mock.handler!(event, { action: "workspace_root", path: "D:/AIwork" });
  expect(command).toHaveBeenCalledWith({
    action: "workspace_root",
    path: "D:/AIwork",
  });
});
