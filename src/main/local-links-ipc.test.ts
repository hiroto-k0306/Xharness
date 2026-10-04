import { beforeEach, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { LocalLinkHost } from "./local-links.js";
import { LOCAL_LINK_CHANNEL } from "../shared/local-links.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: IpcMainInvokeEvent, raw: unknown) => Promise<boolean>
  >(),
  handle: vi.fn(async () => true),
  host: undefined as LocalLinkHost | undefined,
  dialog: vi.fn(async () => ({ response: 0 })),
  open: vi.fn(async () => ""),
  reveal: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: {},
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, raw: unknown) => Promise<boolean>,
    ) => mocks.handlers.set(channel, handler),
  },
  dialog: { showMessageBox: mocks.dialog },
  shell: { openPath: mocks.open, showItemInFolder: mocks.reveal },
}));
vi.mock("./local-links.js", () => ({
  LocalLinks: class {
    constructor(host: LocalLinkHost) {
      mocks.host = host;
    }
    handle = mocks.handle;
  },
}));
import { registerLocalLinksIpc } from "./ipc.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.dialog.mockResolvedValue({ response: 0 });
});
function setup() {
  const wc = { mainFrame: {}, executeJavaScript: vi.fn(async () => true) };
  const win = {
    webContents: wc,
    isDestroyed: () => false,
  } as unknown as BrowserWindow;
  registerLocalLinksIpc(() => win);
  return {
    wc,
    win,
    handler: mocks.handlers.get(LOCAL_LINK_CHANNEL)!,
    event: {
      sender: wc,
      senderFrame: wc.mainFrame,
    } as unknown as IpcMainInvokeEvent,
  };
}
it("rejects foreign senders and child frames before consulting activation", async () => {
  const { wc, handler, event } = setup();
  expect(
    await handler(
      { ...event, sender: {} } as IpcMainInvokeEvent,
      "file:///C:/a",
    ),
  ).toBe(false);
  expect(
    await handler(
      { ...event, senderFrame: {} } as IpcMainInvokeEvent,
      "file:///C:/a",
    ),
  ).toBe(false);
  expect(wc.executeJavaScript).not.toHaveBeenCalled();
  expect(mocks.handle).not.toHaveBeenCalled();
});
it("uses main-side activation without manufacturing a user gesture", async () => {
  const { wc, handler, event } = setup();
  wc.executeJavaScript.mockResolvedValue(false);
  await handler(event, "file:///C:/a");
  expect(wc.executeJavaScript).toHaveBeenCalledWith(
    "navigator.userActivation.isActive",
    false,
  );
  expect(mocks.handle).toHaveBeenCalledWith("file:///C:/a", false);
  wc.executeJavaScript.mockRejectedValue(new Error("private error"));
  expect(await handler(event, "file:///C:/a")).toBe(false);
});
it("native confirmation displays the full path with safe cancel/default and three choices", async () => {
  const { handler, event, win } = setup();
  mocks.handle.mockImplementationOnce(async () => {
    expect(await mocks.host!.confirm("C:\\work\\日本 file.exe", false)).toBe(
      "cancel",
    );
    mocks.dialog.mockResolvedValue({ response: 1 });
    expect(await mocks.host!.confirm("C:\\work\\日本 file.exe", false)).toBe(
      "open",
    );
    mocks.dialog.mockResolvedValue({ response: 2 });
    expect(await mocks.host!.confirm("C:\\work\\folder", true)).toBe("folder");
    return true;
  });
  await handler(event, "file:///C:/a");
  expect(mocks.dialog).toHaveBeenNthCalledWith(
    1,
    win,
    expect.objectContaining({
      detail: expect.stringContaining("C:\\work\\日本 file.exe"),
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      buttons: ["キャンセル", "実行", "フォルダを開く（ファイルを表示）"],
    }),
  );
  expect(mocks.host!.active()).toBe(false);
});
