import { app, BrowserWindow, dialog, safeStorage, shell } from "electron";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { fakeUserDataPath } from "./fake-profile.js";
import { loadMainConfig } from "./config/config.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStartupArgs, resolveStartup } from "./config/config.js";
import { readLocalSecrets } from "./auth/local-secrets.js";
import { Authentication } from "./auth/authentication.js";
import { launchOfficialLogin } from "./auth/cli-login.js";
import { ClaudeAdapter } from "./providers/claude/adapter.js";
import { CodexAdapter } from "./providers/codex/adapter.js";
import { FakeProvider } from "./providers/fake/fake-provider.js";
import { SessionController } from "./session/controller.js";
import { fileSecretStore } from "./mcp/secret-file.js";
import {
  confirmAuthentication,
  createHost,
  registerIpc,
  sendEvent,
} from "./ipc.js";
import {
  devToolsAllowed,
  isDevToolsShortcut,
  isExternalHttps,
  secureWebPreferences,
} from "./security.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const startup = parseStartupArgs(process.argv.slice(1));
const fake = startup.fake;
// userData は単一起動ロックより前に分離する。実版・配布版は従来の保存先。
const fakeUserData = fakeUserDataPath(
  fake,
  app.isPackaged,
  process.env.XHARNESS_HOME,
);
if (fakeUserData) {
  mkdirSync(fakeUserData, { recursive: true });
  app.setPath("userData", fakeUserData);
}
let quitting = false;

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
  wc.on("before-input-event", (event, input) => {
    if (
      isDevToolsShortcut(input) &&
      devToolsAllowed(app.isPackaged, startup.devtools)
    ) {
      event.preventDefault();
      wc.toggleDevTools();
    }
  });
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
  // 既定モデル: --model > <home>/config.yaml の main.model / main.effort > claude:opus / high。
  // --fake は設定ファイルを読まず、通信もしない。
  let main: Awaited<ReturnType<typeof resolveStartup>>;
  try {
    main = await resolveStartup({
      home,
      cliModel: startup.model ?? (fake ? "fake" : undefined),
      cliEffort: startup.effort,
      supported: ["claude", "codex"],
      ...(fake ? { read: async () => "" } : {}),
    });
  } catch (error) {
    dialog.showErrorBox(
      "XHarness",
      error instanceof Error ? error.message : "起動オプションが不正です",
    );
    app.exit(1);
    return;
  }
  const providers = fake
    ? [
        new FakeProvider({ fixturesDir: fixtures, quota: true }),
        new FakeProvider({
          provider: "codex",
          quota: true,
          fixturesDir: app.isPackaged
            ? join(process.resourcesPath, "fixtures-codex")
            : join(app.getAppPath(), "test/fixtures/codex"),
        }),
      ]
    : [
        new ClaudeAdapter(),
        new CodexAdapter({
          toolImageMode: async () =>
            (await loadMainConfig(home)).providers.codex.toolImageMode,
        }),
      ];
  const secrets = fake ? [] : await readLocalSecrets();
  const authentication = fake
    ? undefined
    : new Authentication({
        confirm: (provider) => confirmAuthentication(window, provider),
        launch: launchOfficialLogin,
        refreshSecrets: async () => {
          for (const secret of await readLocalSecrets())
            if (!secrets.includes(secret)) secrets.push(secret);
        },
        changed: () => {
          void controller
            ?.state()
            .then((state) => sendEvent(window, { type: "state", state }))
            .catch(() => undefined);
        },
      });
  controller = new SessionController({
    authentication,
    phase4: true,
    cliModel: startup.model,
    cliEffort: startup.effort as
      "low" | "medium" | "high" | "xhigh" | "max" | undefined,
    provider: providers.find((p) => p.id === main.choice.provider)!,
    providers,
    fallback: main.fallback,
    web: main.web,
    model: main.choice.model,
    effort: main.choice.effort,
    aliases: main.aliases,
    warnings: main.warnings,
    home,
    fake,
    version: app.getVersion(),
    // --fake では資格情報ファイルを読まない
    secrets,
    host: createHost(() => window),
    emit: (event) => sendEvent(window, event),
    // MCP の OAuth トークンは OS の暗号化(Windows では DPAPI)で保存する。使えなければ OAuth を使わない
    ...(!fake && safeStorage.isEncryptionAvailable()
      ? {
          mcpSecrets: fileSecretStore(join(home, "secrets"), {
            encrypt: (text) => safeStorage.encryptString(text),
            decrypt: (data) => safeStorage.decryptString(data),
          }),
          openExternal: (url: string) => void shell.openExternal(url),
        }
      : {}),
  });
  await controller.init();
  if (startup.resume) {
    const resumed = await controller.handle({
      type: "open_session",
      sessionId: startup.resume,
    });
    if (!resumed.ok)
      dialog.showErrorBox("XHarness", "指定されたセッションを再開できません");
  }
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
  // 2つ目の起動は終了し、既にあるウィンドウを前面に出す(黙って消えたように見せない)
  app.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  void app.whenReady().then(start);
  app.on("window-all-closed", () => app.quit());
  // 終了前に、権限待ちを deny で解決して実行中のターンを中断し、履歴を保存してから抜ける
  app.on("before-quit", (event) => {
    if (quitting || !controller) return;
    quitting = true;
    event.preventDefault();
    void controller.shutdown().finally(() => app.quit());
  });
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
}
