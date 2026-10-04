import type { Stats } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isLocalDrive, localFilePath, LocalLinks } from "./local-links.js";

const url = "file:///C:/work/%E6%97%A5%E6%9C%AC%20file.txt";
const path = "C:\\work\\日本 file.txt";
function setup(directory = false) {
  const info = {
    dev: 1,
    ino: 2,
    size: 3,
    mtimeMs: 4,
    ctimeMs: 5,
    isFile: () => !directory,
    isDirectory: () => directory,
  } as Stats;
  const host = {
    confirm: vi.fn(async (): Promise<"open" | "folder" | "cancel"> => "cancel"),
    open: vi.fn(async () => ""),
    reveal: vi.fn(),
    active: vi.fn(() => true),
  };
  const drive = vi.fn(async () => true);
  const resolve = vi.fn(async () => path);
  const inspect = vi.fn(async () => info);
  return {
    host,
    drive,
    resolve,
    inspect,
    links: new LocalLinks(host, drive, resolve, inspect),
    info,
  };
}

describe("local file links", () => {
  it("decodes local Windows URLs, including spaces and Japanese", () => {
    expect(localFilePath(url)).toBe(path);
    expect(localFilePath("file:///D:/")).toBe("D:\\");
  });
  it.each([
    undefined,
    {},
    "https://example.com",
    "javascript:alert(1)",
    "file://server/share/a",
    "file://localhost/C:/a",
    "file:////server/share/a",
    "file:///C:relative",
    "file:///etc/passwd",
    "file:///C:/a?query",
    "file:///C:/a#hash",
    "file:///C:/a%00",
    "file:///C:/a%0A",
    "file:///C:/a%5cb",
    "file:///C:/a%2fb",
    "file:///C:/%zz",
    "file:///C:/a:stream",
    "file:///C:/CON.txt",
    "file:///C:/COM%C2%B9.txt",
    "file:///C:/CONOUT$",
    "file:///C:/a.",
    "file:///C:/a%20",
    "file:///C:/../a",
    "file:///C:/%2e%2e/a",
    "file:///C:/a\\b",
    " file:///C:/a",
    "file:///C:/a%E2%80%AE.exe",
    "file:///C:/a//b",
    "file:///C:/a\n",
  ])("rejects malformed, remote and ambiguous URL %s", (value) => {
    expect(localFilePath(value)).toBeUndefined();
  });
  it("never confirms or launches without a user gesture", async () => {
    const { links, host, drive } = setup();
    expect(await links.handle(url, false)).toBe(false);
    expect(drive).not.toHaveBeenCalled();
    expect(host.confirm).not.toHaveBeenCalled();
    expect(host.open).not.toHaveBeenCalled();
  });
  it("cancel is safe; every approved open asks again with the full resolved path", async () => {
    const { links, host } = setup();
    expect(await links.handle(url, true)).toBe(false);
    expect(host.open).not.toHaveBeenCalled();
    host.confirm.mockResolvedValue("open");
    expect(await links.handle(url, true)).toBe(true);
    expect(await links.handle(url, true)).toBe(true);
    expect(host.confirm).toHaveBeenCalledTimes(3);
    expect(host.confirm).toHaveBeenCalledWith(path, false);
    expect(host.open).toHaveBeenCalledWith(path);
  });
  it("reveals files without executing them and opens directories", async () => {
    const file = setup();
    file.host.confirm.mockResolvedValue("folder");
    expect(await file.links.handle(url, true)).toBe(true);
    expect(file.host.reveal).toHaveBeenCalledWith(path);
    expect(file.host.open).not.toHaveBeenCalled();
    const folder = setup(true);
    folder.host.confirm.mockResolvedValue("folder");
    expect(await folder.links.handle(url, true)).toBe(true);
    expect(folder.host.open).toHaveBeenCalledWith(path);
    expect(folder.host.reveal).not.toHaveBeenCalled();
  });
  it("rejects mapped remote drives, UNC symlink targets and missing files", async () => {
    for (const kind of ["drive", "unc", "missing", "resolvedDrive"]) {
      const { links, host, drive, resolve, inspect } = setup();
      if (kind === "drive") drive.mockResolvedValue(false);
      if (kind === "resolvedDrive")
        drive.mockResolvedValueOnce(true).mockResolvedValue(false);
      if (kind === "unc") resolve.mockResolvedValue("\\\\server\\share\\a");
      if (kind === "missing")
        inspect.mockRejectedValue(new Error("private OS details"));
      expect(await links.handle(url, true)).toBe(false);
      expect(host.confirm).not.toHaveBeenCalled();
      expect(host.open).not.toHaveBeenCalled();
    }
  });
  it("rejects changes during confirmation and destroyed windows", async () => {
    for (const kind of ["path", "identity", "window", "drive"]) {
      const { links, host, resolve, inspect, drive, info } = setup();
      host.confirm.mockImplementation(async () => {
        if (kind === "path") resolve.mockResolvedValue("C:\\other.txt");
        if (kind === "identity")
          inspect.mockResolvedValue({ ...info, ino: 9 } as Stats);
        if (kind === "window") host.active.mockReturnValue(false);
        if (kind === "drive") drive.mockResolvedValue(false);
        return "open";
      });
      expect(await links.handle(url, true)).toBe(false);
      expect(host.open).not.toHaveBeenCalled();
    }
  });
  it("does not stack confirmation dialogs and handles OS errors privately", async () => {
    const { links, host } = setup();
    let finish!: (choice: "open") => void;
    host.confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = links.handle(url, true);
    await vi.waitFor(() => expect(host.confirm).toHaveBeenCalledOnce());
    expect(await links.handle(url, true)).toBe(false);
    host.open.mockResolvedValue("private error path");
    finish("open");
    expect(await first).toBe(false);
    host.confirm.mockResolvedValue("cancel");
    expect(await links.handle(url, true)).toBe(false);
    expect(host.confirm).toHaveBeenCalledTimes(2);
  });
  it.skipIf(process.platform !== "win32")(
    "checks the real Windows local drive without opening files",
    async () => {
      expect(await isLocalDrive(process.cwd())).toBe(true);
      expect(await isLocalDrive("\\\\server\\share\\a")).toBe(false);
    },
    15_000,
  );
});
