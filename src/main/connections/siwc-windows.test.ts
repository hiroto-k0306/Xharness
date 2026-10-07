import { it, expect } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsSiwcBackend, windowsSiwcProtector } from "./siwc-windows.js";
it("refuses plaintext/non-Windows protection", () => {
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: () => Buffer.from("plaintext"),
    decryptString: () => "plaintext",
  };
  expect(windowsSiwcProtector(storage, "linux").available()).toBe(false);
  expect(() =>
    windowsSiwcProtector(
      { ...storage, isEncryptionAvailable: () => false },
      "win32",
    ).encrypt("dummy"),
  ).toThrow("unconfigured");
});
it.skipIf(process.platform !== "win32")(
  "protects dedicated temp directory, replaces atomically and refuses a second writer",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "xh-siwc-blobs-"));
    const key = "1".repeat(64);
    const backend = windowsSiwcBackend(home);
    try {
      const release = await backend.acquire();
      await backend.replaceAtomic(key, Buffer.from("dummy-ciphertext"));
      await expect(windowsSiwcBackend(home).acquire()).rejects.toThrow(
        "unconfigured",
      );
      await backend.replaceAtomic(key, Buffer.from("replacement-ciphertext"));
      expect((await backend.read(key))?.toString()).toBe(
        "replacement-ciphertext",
      );
      expect(
        (await readdir(join(home, "siwc-protected"))).filter((f) =>
          f.endsWith(".tmp"),
        ),
      ).toHaveLength(0);
      expect(
        (await readFile(join(home, "siwc-protected", `${key}.bin`))).toString(),
      ).toBe("replacement-ciphertext");
      await release();
      const reopened = windowsSiwcBackend(home),
        close = await reopened.acquire();
      expect((await reopened.read(key))?.toString()).toBe(
        "replacement-ciphertext",
      );
      await close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
