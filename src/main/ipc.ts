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
import { type ProviderName } from "../shared/ipc.js";

export async function confirmAuthentication(
  win: BrowserWindow | null,
  provider: ProviderName,
) {
  const name = provider === "claude" ? "Claude" : "Codex";
  const options = {
    type: "question" as const,
    title: `${name} の認証・更新`,
    message: `${name} の公式CLIで認証・更新を行うことを許可しますか？`,
    detail:
      "公式CLIの画面とブラウザが開きます。ログイン・認可はご自身で行ってください。資格情報は公式CLIが保存し、XHarnessは読み取りのみ行います。モデルへの依頼は送信しません。",
    buttons: ["キャンセル", "許可して認証する"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
}
import { type Host, type SessionController } from "./session/controller.js";

/** Electron に依存する部分はこのファイルと index.ts だけ(DESIGN.md §4)。 */
export function createHost(getWindow: () => BrowserWindow | null): Host {
  return {
    async saveReport(filename) {
      const win = getWindow();
      const options = {
        defaultPath: filename,
        filters: [{ name: "HTML", extensions: ["html"] }],
      };
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      return result.canceled ? undefined : result.filePath;
    },
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
