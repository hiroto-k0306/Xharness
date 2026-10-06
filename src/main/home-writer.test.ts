import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { acquireHomeWriter, HomeWriterBusy } from "./home-writer.js";

afterEach(() => vi.restoreAllMocks());
const temp = () => mkdtemp(join(tmpdir(), "xh-writer-"));
it("rejects the same canonical home, allows another home, and releases only its owner", async () => {
  const home = await temp();
  const first = await acquireHomeWriter(home);
  await expect(
    acquireHomeWriter(join(home, "nested", "..")),
  ).rejects.toBeInstanceOf(HomeWriterBusy);
  const other = await acquireHomeWriter(await temp());
  await other.release();
  await first.release();
  const next = await acquireHomeWriter(home);
  await next.release();
});
it.each(["live", "reused", "permission", "unknown"])(
  "does not remove %s ownership",
  async (mode) => {
    const home = await temp(),
      path = join(home, ".writer-lock");
    await mkdir(path);
    const text =
      mode === "unknown"
        ? '{"pid":'
        : JSON.stringify({ pid: process.pid, token: "original" });
    await writeFile(join(path, "owner.json"), text);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      if (mode === "permission")
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      return true;
    });
    await expect(acquireHomeWriter(home)).rejects.toBeInstanceOf(
      HomeWriterBusy,
    );
    expect(await readFile(join(path, "owner.json"), "utf8")).toBe(text);
    expect(kill.mock.calls.every((call) => call[1] === 0)).toBe(true);
  },
);
it("reclaims only a confirmed dead owner and fences racing stale claimants", async () => {
  const home = await temp(),
    path = join(home, ".writer-lock");
  await mkdir(path);
  await writeFile(
    join(path, "owner.json"),
    JSON.stringify({ pid: 123456, token: "dead" }),
  );
  vi.spyOn(process, "kill").mockImplementation((pid) => {
    if (pid === 123456)
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    return true;
  });
  const results = await Promise.allSettled([
    acquireHomeWriter(home),
    acquireHomeWriter(home),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  for (const result of results)
    if (result.status === "fulfilled") await result.value.release();
});
