import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compatibleSdk,
  nativePackage,
  registryBytes,
  SDK_NAME,
  unpackSdk,
} from "./sdk-package.js";
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});
function archive(name = "package/sdk.mjs", type = "0") {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write("0000700\0", 100);
  header.write("00000000002\0", 124);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write(
    [...header]
      .reduce((a, b) => a + b, 0)
      .toString(8)
      .padStart(6, "0") + "\0 ",
    148,
  );
  const bytes = gzipSync(
    Buffer.concat([header, Buffer.from("ok"), Buffer.alloc(510 + 1024)]),
  );
  return {
    bytes,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}
describe("SDK package boundary", () => {
  it("accepts same minor stable releases with unchanged dependency contracts only", () => {
    const baseline = {
      name: SDK_NAME,
      version: "0.3.290",
      main: "sdk.mjs",
      type: "module",
      peerDependencies: { zod: "^4.0.0" },
      optionalDependencies: { [nativePackage()]: "0.3.290" },
    };
    const candidate = {
      ...baseline,
      version: "0.3.291",
      optionalDependencies: { [nativePackage()]: "0.3.291" },
    };
    expect(compatibleSdk(candidate, baseline)).toBe(true);
    for (const bad of [
      { version: "0.4.0" },
      { version: "0.3.291-beta.1" },
      { dependencies: { injected: "1" } },
      { peerDependencies: {} },
      { optionalDependencies: {} },
      {
        optionalDependencies: {
          ...candidate.optionalDependencies,
          unknown: "1.0.0",
        },
      },
      { engines: { node: ">=99" } },
    ])
      expect(compatibleSdk({ ...candidate, ...bad }, baseline)).toBe(false);
  });
  it("extracts a verified package without executing anything", async () => {
    const home = await mkdtemp(join(tmpdir(), "sdk-package-"));
    homes.push(home);
    const data = archive();
    await unpackSdk(data.bytes, data.integrity, home);
    expect(await readFile(join(home, "sdk.mjs"), "utf8")).toBe("ok");
    await expect(unpackSdk(data.bytes, "sha512-AAAA", home)).rejects.toThrow(
      "integrity",
    );
  });
  it.each([
    "package/../outside",
    "package/C:/bad",
    "package/link",
    "package/CON.exe",
    "package/a./x",
  ])("rejects unsafe archive entry %s", async (name) => {
    const home = await mkdtemp(join(tmpdir(), "sdk-package-"));
    homes.push(home);
    const data = archive(name, name.endsWith("link") ? "2" : "0");
    await expect(unpackSdk(data.bytes, data.integrity, home)).rejects.toThrow(
      "rejected",
    );
  });
  it("restricts registry, redirects and download size", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("too much"));
    await expect(
      registryBytes("https://example.com/sdk", 30, fetcher),
    ).rejects.toThrow("origin");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      registryBytes("https://registry.npmjs.org/x", 2, fetcher),
    ).rejects.toThrow("large");
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: "error" }),
    );
  });
});
