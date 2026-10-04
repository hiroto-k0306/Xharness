// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { LOCAL_LINK_CHANNEL } from "../shared/local-links.js";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => false),
  expose: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcRenderer: { invoke: mocks.invoke },
  contextBridge: { exposeInMainWorld: mocks.expose },
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
});
it("isolated preload only forwards trusted, activated file clicks; no public opening API", async () => {
  const spy = vi
    .spyOn(window, "addEventListener")
    .mockImplementation(() => undefined);
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    value: { isActive: true },
  });
  await import("./index.js");
  const listener = spy.mock.calls.find(([name]) => name === "click")![1] as (
    event: MouseEvent,
  ) => void;
  const anchor = document.createElement("a");
  anchor.href = "file:///C:/test.txt";
  const click = (trusted: boolean) => {
    const preventDefault = vi.fn();
    listener({
      target: anchor,
      isTrusted: trusted,
      preventDefault,
      stopImmediatePropagation: vi.fn(),
    } as unknown as MouseEvent);
    return preventDefault;
  };
  expect(click(false)).toHaveBeenCalledOnce();
  expect(mocks.invoke).not.toHaveBeenCalled();
  click(true);
  expect(mocks.invoke).toHaveBeenCalledWith(
    LOCAL_LINK_CHANNEL,
    "file:///C:/test.txt",
  );
  mocks.invoke.mockClear();
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    value: { isActive: false },
  });
  click(true);
  expect(mocks.invoke).not.toHaveBeenCalled();
  anchor.href = "https://example.com";
  expect(click(true)).not.toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(Object.keys(mocks.expose.mock.calls[0]![1])).toEqual([
    "command",
    "onEvent",
  ]);
});
