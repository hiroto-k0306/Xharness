import { type BrowserObservation } from "../../shared/local-browser.js";
export type BrowserFrame = Omit<BrowserObservation, "id" | "generation">;
export interface LocalBrowserAdapter {
  readonly mode: "fake" | "electron_local";
  observe(signal: AbortSignal): Promise<BrowserFrame>;
  /** Verify tab/document/URL/frame/rectangle and click in the SAME renderer job. */
  click(
    expected: BrowserFrame,
    signal: AbortSignal,
  ): Promise<{ countAfter: number }>;
  close(): Promise<void>;
}
export type LocalBrowserFactory = () => LocalBrowserAdapter;
