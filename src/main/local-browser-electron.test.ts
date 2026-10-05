import { expect, it, vi } from "vitest";
import { type BrowserWindowConstructorOptions } from "electron";
import { createLocalBrowser } from "./local-browser-electron.js";
const mocks = vi.hoisted(() => {
  const profile = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
    clearStorageData: vi.fn().mockResolvedValue(undefined),
  };
  const wc = {
    id: 100,
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setWebRTCIPHandlingPolicy: vi.fn(),
  };
  return {
    profile,
    wc,
    partition: vi
      .fn<(name: string) => typeof profile>()
      .mockReturnValue(profile),
    options: vi.fn(),
    destroy: vi.fn(),
  };
});
vi.mock("electron", () => ({
  session: { fromPartition: mocks.partition },
  BrowserWindow: class {
    webContents = mocks.wc;
    constructor(options: unknown) {
      mocks.options(options);
    }
    loadURL() {
      return Promise.resolve();
    }
    isDestroyed() {
      return false;
    }
    destroy() {
      mocks.destroy();
    }
  },
}));
it("uses fresh in-memory partitions and strict window policies; denies network/download/permissions/windows in mocks", async () => {
  const a = createLocalBrowser(),
    b = createLocalBrowser();
  const names = mocks.partition.mock.calls.map(
    (c) => c[0] as unknown as string,
  );
  expect(names[0]).not.toBe(names[1]);
  expect(
    names.every(
      (s) => s.startsWith("local-browser-") && !s.startsWith("persist:"),
    ),
  ).toBe(true);
  const options = mocks.options.mock
    .calls[0]![0] as BrowserWindowConstructorOptions;
  expect(options.webPreferences).toMatchObject({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    devTools: false,
    spellcheck: false,
  });
  const before = mocks.profile.webRequest.onBeforeRequest.mock.calls[0]![0] as (
    d: { url: string },
    cb: (r: { cancel: boolean }) => void,
  ) => void;
  for (const url of [
    "https://outside.invalid/",
    "file:///untrusted",
    "data:text/html,arbitrary-page",
  ]) {
    const cb = vi.fn();
    before({ url }, cb);
    expect(cb).toHaveBeenCalledWith({ cancel: true });
  }
  const download = mocks.profile.on.mock.calls.find(
    (c) => c[0] === "will-download",
  )![1] as (e: { preventDefault(): void }) => void;
  const preventDefault = vi.fn();
  download({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  const permission = mocks.profile.setPermissionRequestHandler.mock
    .calls[0]![0] as (
    wc: unknown,
    name: string,
    cb: (allowed: boolean) => void,
  ) => void;
  const allowed = vi.fn();
  permission(null, "media", allowed);
  expect(allowed).toHaveBeenCalledWith(false);
  const popup = mocks.wc.setWindowOpenHandler.mock.calls[0]![0] as () => {
    action: string;
  };
  expect(popup()).toEqual({ action: "deny" });
  expect(mocks.wc.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith(
    "disable_non_proxied_udp",
  );
  await a.close();
  await b.close();
  expect(mocks.destroy).toHaveBeenCalledTimes(2);
});
