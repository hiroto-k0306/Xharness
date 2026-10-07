import { contextBridge, ipcRenderer } from "electron";
import {
  COMMAND_CHANNEL,
  EVENT_CHANNEL,
  type CommandResult,
  type HarnessApi,
  type HarnessCommand,
  type UiEvent,
} from "../shared/ipc.js";

import { LOCAL_LINK_CHANNEL, isFileLink } from "../shared/local-links.js";
import { OFFICIAL_WORKFLOW_CHANNEL } from "../shared/official-workflow.js";

// fileリンクは公開APIにしない。隔離されたpreloadで実際のクリックだけを受ける。
window.addEventListener(
  "click",
  (event) => {
    const anchor =
      event.target instanceof Element ? event.target.closest("a[href]") : null;
    const href = anchor?.getAttribute("href");
    if (!href || !isFileLink(href)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.isTrusted || !navigator.userActivation.isActive) return;
    void ipcRenderer.invoke(LOCAL_LINK_CHANNEL, href).catch(() => undefined);
  },
  true,
);

// 画面側へ渡すのは、型付きの command()/onEvent() と限定workflow操作だけ。
// ipcRenderer 本体・トークン・ファイルパスの読み取り手段は公開しない。
const api: HarnessApi = {
  officialWorkflow: (command) =>
    ipcRenderer.invoke(OFFICIAL_WORKFLOW_CHANNEL, command),
  command: (command: HarnessCommand): Promise<CommandResult> =>
    ipcRenderer.invoke(COMMAND_CHANNEL, command),
  onEvent(listener) {
    const handler = (_event: unknown, payload: UiEvent) => listener(payload);
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler);
  },
};
contextBridge.exposeInMainWorld("harness", api);
