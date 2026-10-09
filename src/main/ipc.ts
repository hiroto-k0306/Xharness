import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
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
import { LOCAL_LINK_CHANNEL } from "../shared/local-links.js";
import { LocalLinks } from "./local-links.js";

/** 任意のローカルパスを一般commandから開くAPIは設けない。 */
export function registerLocalLinksIpc(getWindow: () => BrowserWindow | null) {
  let owner: BrowserWindow | null = null;
  const links = new LocalLinks({
    active: () => !!owner && !owner.isDestroyed() && owner === getWindow(),
    async confirm(path, directory) {
      if (!owner || owner.isDestroyed()) return "cancel";
      const result = await dialog.showMessageBox(owner, {
        type: "warning",
        title: "ローカルファイルを開く",
        message: "このローカルリンクを開きますか？",
        detail: `${path}\n\n「実行」は既定のアプリで開きます。プログラムやスクリプトの場合はコードが実行される可能性があります。信頼できる対象だけ許可してください。`,
        buttons: [
          "キャンセル",
          "実行",
          directory ? "フォルダを開く" : "フォルダを開く（ファイルを表示）",
        ],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1
        ? "open"
        : result.response === 2
          ? "folder"
          : "cancel";
    },
    open: (path) => shell.openPath(path),
    reveal: (path) => shell.showItemInFolder(path),
  });
  let pending = false;
  ipcMain.handle(
    LOCAL_LINK_CHANNEL,
    async (event: IpcMainInvokeEvent, raw: unknown) => {
      const win = getWindow();
      if (
        !win ||
        win.isDestroyed() ||
        pending ||
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame
      )
        return false;
      pending = true;
      owner = win;
      try {
        // renderer申告のbooleanは信じない。Chromiumのユーザーactivationをmainで照会。
        // trueを第2引数に渡すとactivationを作ってしまうので必ずfalse。
        const activated = await win.webContents.executeJavaScript(
          "navigator.userActivation.isActive",
          false,
        );
        return await links.handle(raw, activated === true);
      } catch {
        return false;
      } finally {
        owner = null;
        pending = false;
      }
    },
  );
}

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

/** Electron に依存する部分はこのファイルと index.ts だけ(旧設計 Old/DESIGN-9a275bc.md §4)。 */
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
  registerLocalLinksIpc(getWindow);
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
