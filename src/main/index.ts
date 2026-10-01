import { app, BrowserWindow, shell } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalSecrets } from "./auth/local-secrets.js";
import { ClaudeAdapter } from "./providers/claude/adapter.js";
import { FakeProvider } from "./providers/fake/fake-provider.js";
import { SessionController } from "./session/controller.js";
import { createHost, registerIpc, sendEvent } from "./ipc.js";
import { isExternalHttps, secureWebPreferences } from "./security.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(1);
const fake = args.includes("--fake");
const modelArg = args.indexOf("--model");
const model = fake
  ? "fake"
  : modelArg >= 0
    ? (args[modelArg + 1] ?? "claude-haiku-4-5")
    : "claude-haiku-4-5";

let window: BrowserWindow | null = null;
let controller: SessionController | undefined;

function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    // §17.2: 起動時の白いちらつきを防ぐ
    backgroundColor: "#141518",
    frame: false,
    titleBarStyle: "hidden",
    // Windows 標準の最小化・最大化・閉じるボタンを残し、タブバーは自前で描画する
    titleBarOverlay: { color: "#141518", symbolColor: "#d4d7dd", height: 36 },
    webPreferences: secureWebPreferences(join(here, "../preload/index.cjs")),
  });
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => (window = null));
  const wc = window.webContents;
  // 外部リンクは既定ブラウザへ。アプリ内のナビゲーション・新規ウィンドウは許可しない
  wc.setWindowOpenHandler(({ url }) => {
    if (isExternalHttps(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (event, url) => {
    if (url !== wc.getURL()) event.preventDefault();
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(here, "../renderer/index.html"));
}

async function start() {
  const base = process.env.XHARNESS_HOME;
  // --fake は本物のセッション履歴を汚さないよう別の場所を使う
  const home = base ?? join(homedir(), fake ? ".xharness-fake" : ".xharness");
  const fixtures = app.isPackaged
    ? join(process.resourcesPath, "fixtures")
    : join(app.getAppPath(), "test/fixtures/claude");
  controller = new SessionController({
    provider: fake
      ? new FakeProvider({ fixturesDir: fixtures })
      : new ClaudeAdapter(),
    model,
    home,
    fake,
    version: app.getVersion(),
    // --fake では資格情報ファイルを読まない
    secrets: fake ? [] : await readLocalSecrets(),
    host: createHost(() => window),
    emit: (event) => sendEvent(window, event),
  });
  await controller.init();
  registerIpc(
    () => controller!,
    () => window,
  );
  createWindow();
}

// 画面からの権限は一切与えない
app.on("web-contents-created", (_e, contents) => {
  contents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  void app.whenReady().then(start);
  app.on("window-all-closed", () => app.quit());
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
}
