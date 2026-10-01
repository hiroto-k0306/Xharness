import { type HarnessApi } from "../shared/ipc.js";

declare global {
  interface Window {
    /** preload が contextBridge で公開する型付き API(これだけ) */
    harness: HarnessApi;
  }
}
