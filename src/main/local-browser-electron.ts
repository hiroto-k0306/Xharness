import { BrowserWindow, session } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { LOCAL_FIXTURE_URL } from "../shared/local-browser.js";
import {
  type BrowserFrame,
  type LocalBrowserAdapter,
} from "./computer-use/adapter.js";
import {
  LOCAL_BROWSER_HTML,
  LOCAL_STATE_SCRIPT,
} from "./computer-use/fixture.js";

const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
/** Unique non-persistent partition. No user profile/cookies/preload/Node access. */
export function createLocalBrowser(): LocalBrowserAdapter {
  const profile = session.fromPartition(`local-browser-${randomUUID()}`, {
    cache: false,
  });
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(LOCAL_BROWSER_HTML)}`;
  profile.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  profile.setPermissionCheckHandler(() => false);
  profile.on("will-download", (event) => event.preventDefault());
  profile.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: details.url !== url }),
  );
  const window = new BrowserWindow({
    title: "XHarness isolated local fixture",
    show: false,
    frame: false,
    useContentSize: true,
    width: 580,
    height: 360,
    webPreferences: {
      session: profile,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  const wc = window.webContents,
    tabId = `electron-${wc.id}`;
  wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  let documentId = randomUUID(),
    closed = false;
  wc.on("did-navigate", () => {
    documentId = randomUUID();
  });
  wc.on("did-navigate-in-page", () => {
    documentId = randomUUID();
  });
  wc.on("will-navigate", (event) => event.preventDefault());
  wc.on("will-redirect", (event) => event.preventDefault());
  wc.on("will-attach-webview", (event) => event.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  const loaded = window.loadURL(url);
  void loaded.catch(() => undefined);
  const assert = (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (
      closed ||
      wc.isDestroyed() ||
      wc.getURL() !== url ||
      wc.getZoomFactor() !== 1
    )
      throw new Error("Local fixture/tab changed");
  };
  const state = async (signal: AbortSignal) => {
    await loaded;
    assert(signal);
    const s = (await wc.executeJavaScript(LOCAL_STATE_SCRIPT)) as {
      dom: string;
      count: number;
      target: BrowserFrame["target"];
    };
    assert(signal);
    return s;
  };
  return {
    mode: "electron_local",
    async observe(signal) {
      const before = await state(signal),
        doc = documentId;
      const image = await wc.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      });
      const after = await state(signal);
      if (
        doc !== documentId ||
        digest(before) !== digest(after) ||
        image.isEmpty()
      )
        throw new Error("Frame changed during capture");
      const png = image.toPNG();
      if (png.length > 2_000_000) throw new Error("Image too large");
      return {
        tabId,
        documentId: doc,
        url: LOCAL_FIXTURE_URL,
        frameHash: digest({ tabId, documentId: doc, state: before }),
        imageHash: createHash("sha256").update(png).digest("hex"),
        image: `data:image/png;base64,${png.toString("base64")}`,
        width: 580,
        height: 360,
        count: before.count,
        target: before.target,
      };
    },
    async click(expected, signal) {
      const current = await state(signal);
      if (
        expected.url !== LOCAL_FIXTURE_URL ||
        expected.tabId !== tabId ||
        expected.documentId !== documentId ||
        expected.frameHash !== digest({ tabId, documentId, state: current })
      )
        throw new Error("Stale tab/frame/target");
      const doc = documentId;
      // Revalidate AND click within one synchronous renderer evaluation, so DOM
      // mutation cannot redirect stale coordinates between the check and action.
      const result = await wc.executeJavaScript(`(() => {
        const state=${LOCAL_STATE_SCRIPT};
        if(JSON.stringify(state)!==${JSON.stringify(JSON.stringify(current))} || location.href!==${JSON.stringify(url)}) throw Error('Stale fixture');
        document.querySelector('button[data-target="increment"]').click();
        return Number(document.getElementById('count').textContent);
      })()`);
      assert(signal);
      if (doc !== documentId || result !== expected.count + 1)
        throw new Error("Action result uncertain");
      return { countAfter: result as number };
    },
    async close() {
      closed = true;
      if (!window.isDestroyed()) window.destroy();
      await profile.clearStorageData();
    },
  };
}
