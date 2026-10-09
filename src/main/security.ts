// electron を import しない(型だけ)。BrowserWindow の安全側の設定を1か所に集める。
// 旧設計 Old/DESIGN-9a275bc.md §14: contextIsolation: true / nodeIntegration: false / sandbox: true。
import type { WebPreferences } from "electron";

export function secureWebPreferences(preload: string): WebPreferences {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
  };
}

/** 外部リンクとして既定ブラウザへ渡してよい URL(https のみ) */
export function isExternalHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** フレームレスのウィンドウでも手順書の診断ショートカットを使えるようにする。 */
export function isDevToolsShortcut(input: {
  type: string;
  key: string;
  control: boolean;
  shift: boolean;
  alt: boolean;
}): boolean {
  return (
    input.type === "keyDown" &&
    input.control &&
    input.shift &&
    !input.alt &&
    input.key.toLowerCase() === "i"
  );
}

/**
 * DevTools を開いてよいか。開発起動では常に可、パッケージ版は `--devtools` を付けたときだけ。
 * (画面側は sandbox のままなので権限は上がらないが、普段の配布物では開けないようにする)
 */
export function devToolsAllowed(packaged: boolean, flag: boolean): boolean {
  return !packaged || flag;
}
