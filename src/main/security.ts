// electron を import しない(型だけ)。BrowserWindow の安全側の設定を1か所に集める。
// DESIGN.md §14: contextIsolation: true / nodeIntegration: false / sandbox: true。
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
