import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
} from "electron";
import {
  COMMAND_CHANNEL,
  EVENT_CHANNEL,
  parseCommand,
  type CommandResult,
  type UiEvent,
} from "../shared/ipc.js";
import { type Host, type SessionController } from "./session/controller.js";

/** Electron に依存する部分はこのファイルと index.ts だけ(DESIGN.md §4)。 */
export function createHost(getWindow: () => BrowserWindow | null): Host {
  return {
    async pickFolder() {
      const win = getWindow();
      const options = { properties: ["openDirectory" as const] };
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? undefined : result.filePaths[0];
    },
  };
}

export function sendEvent(win: BrowserWindow | null, event: UiEvent) {
  if (win && !win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, event);
}

export function registerIpc(
  getController: () => SessionController,
  getWindow: () => BrowserWindow | null,
) {
  ipcMain.handle(
    COMMAND_CHANNEL,
    async (event: IpcMainInvokeEvent, raw: unknown): Promise<CommandResult> => {
      // 自分のウィンドウのメインフレームからの呼び出しだけを受け付ける
      const win = getWindow();
      if (
        !win ||
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame
      )
        return { ok: false, error: "Rejected sender" };
      const command = parseCommand(raw);
      if (!command) return { ok: false, error: "Invalid command" };
      return getController().handle(command);
    },
  );
}
