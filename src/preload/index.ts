import { contextBridge, ipcRenderer } from "electron";
import {
  COMMAND_CHANNEL,
  EVENT_CHANNEL,
  type CommandResult,
  type HarnessApi,
  type HarnessCommand,
  type UiEvent,
} from "../shared/ipc.js";

// 画面側へ渡すのは、型付きの command() と onEvent() だけ。
// ipcRenderer 本体・トークン・ファイルパスの読み取り手段は公開しない。
const api: HarnessApi = {
  command: (command: HarnessCommand): Promise<CommandResult> =>
    ipcRenderer.invoke(COMMAND_CHANNEL, command),
  onEvent(listener) {
    const handler = (_event: unknown, payload: UiEvent) => listener(payload);
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler);
  },
};
contextBridge.exposeInMainWorld("harness", api);
