import { createHash, randomUUID } from "node:crypto";
import { LOCAL_FIXTURE_URL } from "../../shared/local-browser.js";
import { type LocalBrowserAdapter, type BrowserFrame } from "./adapter.js";
export class FakeLocalBrowser implements LocalBrowserAdapter {
  readonly mode = "fake";
  readonly tabId = randomUUID();
  documentId: string = randomUUID();
  count = 0;
  clicks = 0;
  attempts = 0;
  closed = false;
  changed = false;
  beforeClick?: () => Promise<void>;
  async observe(signal: AbortSignal): Promise<BrowserFrame> {
    signal.throwIfAborted();
    if (this.closed) throw new Error("Closed");
    const image =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9X8AAAAASUVORK5CYII=";
    return {
      tabId: this.tabId,
      documentId: this.documentId,
      url: LOCAL_FIXTURE_URL,
      frameHash: createHash("sha256")
        .update(
          JSON.stringify([
            this.tabId,
            this.documentId,
            this.count,
            this.changed,
          ]),
        )
        .digest("hex"),
      imageHash: createHash("sha256")
        .update(Buffer.from(image.split(",")[1]!, "base64"))
        .digest("hex"),
      image,
      width: 580,
      height: 360,
      count: this.count,
      target: {
        id: "increment",
        label: "Increment once",
        x: 32,
        y: 140,
        width: 180,
        height: 50,
      },
    };
  }
  async click(expected: BrowserFrame, signal: AbortSignal) {
    this.attempts++;
    await this.beforeClick?.();
    const current = await this.observe(signal);
    if (
      current.frameHash !== expected.frameHash ||
      current.documentId !== expected.documentId ||
      current.tabId !== expected.tabId ||
      current.url !== expected.url
    )
      throw new Error("Stale frame");
    this.clicks++;
    this.count++;
    return { countAfter: this.count };
  }
  async close() {
    this.closed = true;
  }
}
