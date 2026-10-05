import { EventEmitter } from "node:events";
import { readdir, stat } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { executeRefresh } from "./refresh-cli.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), resolveCli: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../tools/environment.js", () => ({ resolveCli: mocks.resolveCli }));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

function child() {
  return Object.assign(new EventEmitter(), { pid: 12345, kill: vi.fn() });
}
it("runs in an empty temporary directory with discarded output and removes it", async () => {
  mocks.resolveCli.mockResolvedValue(process.execPath);
  const processChild = child();
  mocks.spawn.mockReturnValue(processChild);
  const pending = executeRefresh("claude");
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
  const options = mocks.spawn.mock.calls[0]![2];
  expect(options.stdio).toBe("ignore");
  expect(options.windowsHide).toBe(true);
  expect(await readdir(options.cwd)).toEqual([]);
  processChild.emit("close", 0);
  expect(await pending).toBe("success");
  await expect(stat(options.cwd)).rejects.toThrow();
});
it("does not spawn when the CLI is missing", async () => {
  mocks.resolveCli.mockResolvedValue(undefined);
  expect(await executeRefresh("codex")).toBe("cli_missing");
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it("handles a spawn failure without exposing raw errors", async () => {
  mocks.resolveCli.mockResolvedValue(process.execPath);
  const processChild = child();
  mocks.spawn.mockReturnValue(processChild);
  const pending = executeRefresh("codex");
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
  processChild.emit("error", new Error("synthetic secret"));
  expect(await pending).toBe("failed");
});
it.skipIf(process.platform !== "win32")(
  "terminates the tree at sixty seconds and cleans up",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mocks.resolveCli.mockResolvedValue(process.execPath);
    const processChild = child();
    const killer = child();
    mocks.spawn.mockReturnValueOnce(processChild).mockReturnValueOnce(killer);
    const pending = executeRefresh("codex");
    // Filesystem promises remain real; allow them to settle without advancing the deadline.
    for (let i = 0; i < 100 && mocks.spawn.mock.calls.length === 0; i++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59999);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.spawn.mock.calls[1]?.slice(0, 2)).toEqual([
      "taskkill",
      ["/PID", "12345", "/T", "/F"],
    ]);
    killer.emit("close", 0);
    processChild.emit("close", 1);
    expect(await pending).toBe("timeout");
  },
);
