import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSdkManager } from "./sdk-manager.js";
import { SDK_NAME, nativePackage, type SdkPackage } from "./sdk-package.js";
const homes: string[] = [],
  managers: ClaudeSdkManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.close();
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sdk-manager-"));
  homes.push(home);
  const source = join(home, "bundled"),
    root = join(home, "managed");
  await mkdir(source);
  const baseline: SdkPackage = {
    name: SDK_NAME,
    version: "0.3.290",
    main: "sdk.mjs",
    type: "module",
    optionalDependencies: { [nativePackage()]: "0.3.290" },
  };
  await writeFile(join(source, "package.json"), JSON.stringify(baseline));
  let now = 2000000000000;
  let candidate: SdkPackage = {
    ...baseline,
    version: "0.3.291",
    optionalDependencies: { [nativePackage()]: "0.3.291" },
  };
  const fetcher = vi.fn<typeof fetch>(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).endsWith("/latest")
            ? candidate
            : { name: nativePackage(), version: candidate.version },
        ),
      ),
  );
  const probe = vi.fn(async () => {});
  const seed = vi.fn(async (directory: string) => {
    for (const name of [SDK_NAME, nativePackage()])
      await mkdir(join(directory, "node_modules", name), { recursive: true });
  });
  const download = vi.fn(async (_pkg: SdkPackage, directory: string) => {
    await mkdir(directory, { recursive: true });
  });
  const ports = {
    source: async () => source,
    now: () => now,
    fetch: fetcher,
    seed,
    download,
    probe,
    validate: async (dir: string) => join(dir, "sdk.mjs"),
  };
  const make = () => {
    const m = new ClaudeSdkManager(root, ports);
    managers.push(m);
    return m;
  };
  return {
    root,
    make,
    ports,
    fetcher,
    probe,
    download,
    advance: () => {
      now += 86400000;
    },
    candidate: (next: SdkPackage) => {
      candidate = next;
    },
    baseline,
  };
}
describe("managed SDK lifecycle (no real registry or SDK)", () => {
  it("keeps nested peer dependencies while replacing package files", async () => {
    const f = await fixture();
    const seed = f.ports.seed.getMockImplementation()!;
    f.ports.seed.mockImplementation(async (directory) => {
      await seed(directory);
      const nested = join(
        directory,
        "node_modules",
        SDK_NAME,
        "node_modules",
        "peer-context",
      );
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, "package.json"), '{"version":"1.0.0"}');
      await writeFile(
        join(directory, "node_modules", SDK_NAME, "old-file"),
        "old",
      );
    });
    f.download.mockImplementation(async (pkg, directory) => {
      if (pkg.name === SDK_NAME) {
        expect(
          await readFile(
            join(directory, "node_modules", "peer-context", "package.json"),
            "utf8",
          ),
        ).toContain("1.0.0");
        await expect(
          readFile(join(directory, "old-file")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
    const m = f.make();
    await m.start();
    await m.check();
    expect(m.view()).toMatchObject({ version: "0.3.291", state: "ready" });
  });
  it("allows only one updater across separate managers sharing a root", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    f.download.mockImplementation(async () => {
      await gate;
    });
    const first = f.make();
    await first.start();
    await vi.waitFor(() => expect(f.download).toHaveBeenCalledTimes(1));
    const second = f.make();
    await second.start();
    await second.check();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    release();
    await first.check();
    expect(first.view().version).toBe("0.3.291");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("seeds, updates atomically, pins a captured entry and shares concurrent checks", async () => {
    const f = await fixture(),
      m = f.make();
    await m.start();
    const oldEntry = m.selectedEntry();
    await Promise.all([m.check(), m.check(), m.check()]);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.download).toHaveBeenCalledTimes(2);
    expect(oldEntry).toContain("v0.3.290-");
    expect(m.selectedEntry()).toContain("v0.3.291-");
    expect(
      JSON.parse(await readFile(join(f.root, "active.json"), "utf8")).version,
    ).toBe("0.3.291");
    await m.check();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    await m.close();
    const restarted = f.make();
    await restarted.start();
    await restarted.check();
    expect(restarted.view().version).toBe("0.3.291");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.advance();
    await restarted.check();
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  it("preserves the current installation when download fails, with daily failed-attempt limit", async () => {
    const f = await fixture();
    f.download.mockRejectedValue(new Error("do-not-log-secret"));
    const m = f.make();
    await m.start();
    await m.check();
    expect(m.view()).toMatchObject({ version: "0.3.290", state: "attention" });
    expect(JSON.stringify(m.view())).not.toContain("do-not-log-secret");
    await m.check();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(await readFile(join(f.root, "active.json"), "utf8")).version,
    ).toBe("0.3.290");
  });
  it("does not install an incompatible candidate", async () => {
    const f = await fixture();
    f.candidate({ ...f.baseline, version: "0.4.0" });
    const m = f.make();
    await m.start();
    await m.check();
    expect(f.download).not.toHaveBeenCalled();
    expect(m.view().message).toContain("互換範囲外");
  });
  it("refuses unknown or corrupt active pointers without silently reseeding", async () => {
    const f = await fixture();
    await mkdir(f.root);
    await writeFile(
      join(f.root, "active.json"),
      '{"directory":"../../evil","version":"0.3.291"}',
    );
    const m = f.make();
    await m.start();
    await m.check();
    expect(() => m.selectedEntry()).toThrow("準備できません");
    expect(f.ports.seed).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("does not silently roll back a saved installation with missing files", async () => {
    const f = await fixture();
    await mkdir(f.root);
    const pointer = {
      directory: "v0.3.291-11111111-1111-4111-8111-111111111111",
      version: "0.3.291",
    };
    await writeFile(join(f.root, "active.json"), JSON.stringify(pointer));
    f.ports.validate = async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    const m = f.make();
    await m.start();
    expect(() => m.selectedEntry()).toThrow();
    expect(f.ports.seed).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(
      JSON.parse(await readFile(join(f.root, "active.json"), "utf8")),
    ).toEqual(pointer);
  });
  it("does not replace an active version when contract probing fails", async () => {
    const f = await fixture();
    f.probe.mockImplementation(async (entry?: string) => {
      if (entry?.includes("0.3.291")) throw new Error("unsupported");
    });
    const m = f.make();
    await m.start();
    await m.check();
    expect(m.view()).toMatchObject({ version: "0.3.290", state: "attention" });
    expect(
      JSON.parse(await readFile(join(f.root, "active.json"), "utf8")).version,
    ).toBe("0.3.290");
  });
  it("respects another process update lock without registry traffic", async () => {
    const f = await fixture();
    await mkdir(f.root);
    await writeFile(join(f.root, "update.lock"), "{}");
    const m = f.make();
    await m.start();
    expect(() => m.selectedEntry()).toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(await readFile(join(f.root, "update.lock"), "utf8")).toBe("{}");
  });
});
