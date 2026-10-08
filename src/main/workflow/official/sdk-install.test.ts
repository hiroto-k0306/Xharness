import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { packageJson, seedSdk } from "./sdk-install.js";
import { SDK_NAME, nativePackage } from "./sdk-package.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});
async function pkg(
  modules: string,
  name: string,
  version = "1.0.0",
  extra: Record<string, unknown> = {},
) {
  const directory = join(modules, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name, version, main: "index.cjs", ...extra }),
  );
  await writeFile(
    join(directory, "index.cjs"),
    `module.exports = ${JSON.stringify(version)};`,
  );
  return directory;
}
async function fixture(
  dependencies: Record<string, string> = {},
  extra: Record<string, unknown> = {},
) {
  const home = await mkdtemp(join(tmpdir(), "xh-sdk-seed-"));
  homes.push(home);
  const modules = join(home, "source", "node_modules");
  const source = await pkg(modules, SDK_NAME, "0.3.290", {
    dependencies,
    optionalDependencies: { [nativePackage()]: "0.3.290" },
    ...extra,
  });
  await writeFile(
    join(source, "index.cjs"),
    "throw new Error('SDK must not execute during seed');",
  );
  const native = await pkg(modules, nativePackage(), "0.3.290");
  const binary = process.platform === "win32" ? "claude.exe" : "claude";
  await writeFile(join(native, binary), Buffer.from([0, 1, 128, 255]));
  return {
    modules,
    source,
    native,
    binary,
    destination: join(home, "installed"),
  };
}
function dependencyFrom(directory: string, dependency: string) {
  const require = createRequire(join(directory, "index.cjs"));
  return require(dependency) as string;
}
describe("SDK dependency seeding (synthetic packages only)", () => {
  it("carries installed optional dependencies of peers and skips missing/platform-incompatible ones", async () => {
    const f = await fixture({ "seed-parent": "1.0.0" });
    await pkg(f.modules, "seed-parent", "1.0.0", {
      optionalDependencies: {
        "seed-optional": "1.0.0",
        "seed-missing": "1.0.0",
        "seed-other-os": "1.0.0",
      },
    });
    await pkg(f.modules, "seed-optional");
    await pkg(f.modules, "seed-other-os", "1.0.0", { os: ["nonexistent-os"] });
    await seedSdk(f.destination, f.source);
    expect(
      dependencyFrom(
        join(f.destination, "node_modules", "seed-parent"),
        "seed-optional",
      ),
    ).toBe("1.0.0");
    await expect(
      readFile(
        join(f.destination, "node_modules", "seed-other-os", "package.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("copies the complete SDK/native and peer closure without loading modules or install scripts", async () => {
    const f = await fixture(
      { "seed-direct": "1.0.0" },
      {
        peerDependencies: {
          "seed-peer": "1.0.0",
          "seed-optional-missing": "1.0.0",
        },
        peerDependenciesMeta: { "seed-optional-missing": { optional: true } },
        scripts: { postinstall: "this-must-not-execute" },
      },
    );
    await pkg(f.modules, "seed-direct", "1.0.0", {
      dependencies: { "seed-child": "1.0.0" },
    });
    await pkg(f.modules, "seed-child");
    await pkg(f.modules, "seed-peer");
    await seedSdk(f.destination, f.source);
    const target = join(f.destination, "node_modules");
    expect(await readFile(join(target, nativePackage(), f.binary))).toEqual(
      Buffer.from([0, 1, 128, 255]),
    );
    expect(
      await readFile(join(target, SDK_NAME, "index.cjs"), "utf8"),
    ).toContain("must not execute");
    expect(dependencyFrom(join(target, SDK_NAME), "seed-direct")).toBe("1.0.0");
    expect(dependencyFrom(join(target, SDK_NAME), "seed-peer")).toBe("1.0.0");
    expect(dependencyFrom(join(target, "seed-direct"), "seed-child")).toBe(
      "1.0.0",
    );
    await expect(
      readFile(join(target, "seed-optional-missing", "package.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps conflicting versions under their owner and preserves Node resolution", async () => {
    const f = await fixture({ "seed-left": "1.0.0", "seed-right": "1.0.0" });
    const left = await pkg(f.modules, "seed-left", "1.0.0", {
      dependencies: { "seed-shared": "1.0.0" },
    });
    const right = await pkg(f.modules, "seed-right", "1.0.0", {
      dependencies: { "seed-shared": "2.0.0" },
    });
    await pkg(join(left, "node_modules"), "seed-shared", "1.0.0");
    await pkg(join(right, "node_modules"), "seed-shared", "2.0.0");
    await seedSdk(f.destination, f.source);
    const target = join(f.destination, "node_modules");
    expect(dependencyFrom(join(target, "seed-left"), "seed-shared")).toBe(
      "1.0.0",
    );
    expect(dependencyFrom(join(target, "seed-right"), "seed-shared")).toBe(
      "2.0.0",
    );
    expect((await packageJson(join(target, "seed-shared"))).version).toBe(
      "1.0.0",
    );
    expect(
      (
        await packageJson(
          join(target, "seed-right", "node_modules", "seed-shared"),
        )
      ).version,
    ).toBe("2.0.0");
  });
  it("terminates circular dependencies while keeping their resolution intact", async () => {
    const f = await fixture({ "seed-a": "1.0.0" });
    await pkg(f.modules, "seed-a", "1.0.0", {
      dependencies: { "seed-b": "1.0.0" },
    });
    await pkg(f.modules, "seed-b", "1.0.0", {
      dependencies: { "seed-a": "1.0.0" },
    });
    await seedSdk(f.destination, f.source);
    const target = join(f.destination, "node_modules");
    expect(dependencyFrom(join(target, "seed-a"), "seed-b")).toBe("1.0.0");
    expect(dependencyFrom(join(target, "seed-b"), "seed-a")).toBe("1.0.0");
    expect(
      (await readdir(target, { recursive: true })).filter((file) =>
        file.endsWith("package.json"),
      ),
    ).toHaveLength(4);
  });
  it("preserves distinct peer contexts even when the owning package has the same version", async () => {
    const f = await fixture({ "seed-left": "1.0.0", "seed-right": "1.0.0" });
    for (const [name, peer] of [
      ["seed-left", "1.0.0"],
      ["seed-right", "2.0.0"],
    ]) {
      const owner = await pkg(f.modules, name!, "1.0.0", {
        dependencies: { "seed-peer-owner": "1.0.0" },
      });
      const dependency = await pkg(
        join(owner, "node_modules"),
        "seed-peer-owner",
        "1.0.0",
        { peerDependencies: { "seed-context": "*" } },
      );
      await writeFile(
        join(dependency, "index.cjs"),
        "module.exports = require('seed-context');",
      );
      await pkg(join(owner, "node_modules"), "seed-context", peer!);
    }
    await seedSdk(f.destination, f.source);
    const target = join(f.destination, "node_modules");
    expect(dependencyFrom(join(target, "seed-left"), "seed-peer-owner")).toBe(
      "1.0.0",
    );
    expect(dependencyFrom(join(target, "seed-right"), "seed-peer-owner")).toBe(
      "2.0.0",
    );
  });
  it("finds package metadata when exports has no root and maps package.json to a nameless dist stub", async () => {
    const name = "@synthetic/seed-protocol";
    const f = await fixture({ [name]: "1.0.0" });
    const dependency = await pkg(f.modules, name, "1.0.0", {
      exports: {
        "./client": "./dist/client.cjs",
        "./package.json": "./dist/cjs/package.json",
      },
    });
    await mkdir(join(dependency, "dist", "cjs"), { recursive: true });
    await writeFile(
      join(dependency, "dist", "cjs", "package.json"),
      '{"type":"commonjs"}',
    );
    await writeFile(
      join(dependency, "dist", "client.cjs"),
      'module.exports = "synthetic-client";',
    );
    const original = createRequire(join(f.source, "index.cjs"));
    expect(() => original.resolve(name)).toThrow();
    expect(original(`${name}/package.json`)).toEqual({ type: "commonjs" });
    await seedSdk(f.destination, f.source);
    const target = join(f.destination, "node_modules");
    expect((await packageJson(join(target, name))).name).toBe(name);
    expect(dependencyFrom(join(target, SDK_NAME), `${name}/client`)).toBe(
      "synthetic-client",
    );
  });
  it("refuses a missing required dependency", async () => {
    const f = await fixture({ "seed-required-missing": "1.0.0" });
    await expect(seedSdk(f.destination, f.source)).rejects.toThrow();
  });
  it.each([
    "../escape",
    "@scope/../escape",
    "C:/escape",
    "name:stream",
    ".",
    "..",
    "@scope/..",
  ])("rejects malformed package name %s before copying", async (name) => {
    const f = await fixture();
    await writeFile(
      join(f.source, "package.json"),
      JSON.stringify({ name, version: "1.0.0" }),
    );
    await expect(seedSdk(f.destination, f.source)).rejects.toThrow(
      "sdk-package-name-invalid",
    );
    await expect(readdir(f.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
