import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Config {
  appId: string;
  productName: string;
  directories: { output: string };
  files: string[];
  extraResources: { from: string; to: string; filter: string[] }[];
  win: { target: string[]; icon: string };
  nsis: { artifactName: string };
  portable: { artifactName: string; unpackDirName?: string | boolean };
  publish: unknown;
}
const config = parse(await readFile("electron-builder.yml", "utf8")) as Config;
const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
  main: string;
};

describe("electron-builder.yml (DESIGN §17.2)", () => {
  it("builds nsis and portable for Windows with the generated icon", async () => {
    expect(config.appId).toBe("local.xharness.app");
    expect(config.productName).toBe("XHarness");
    expect(config.win.target).toEqual(["nsis", "portable"]);
    expect(config.win.icon).toBe("resources/icon.ico");
    await expect(access(config.win.icon)).resolves.toBeUndefined();
    expect(config.nsis.artifactName).toBe("XHarness-Setup-${version}.${ext}");
    expect(config.portable.artifactName).toBe(
      "XHarness-${version}-portable.${ext}",
    );
  });
  it("packs only the built output, never sources or credentials", () => {
    expect(config.files).toContain("out/**");
    expect(pkg.main).toBe("out/main/index.js");
    expect(config.files.filter((f) => !f.startsWith("!"))).toEqual([
      "out/**",
      "package.json",
      "catalog/models.yaml",
    ]);
    expect(config.publish).toBeNull(); // 自動アップデートは v1 では行わない
  });
  it("isolates portable extraction so a second launch cannot delete the first's fixtures", () => {
    // electron-builder 26.15.3: true は UNPACK_DIR_NAME を定義せず、
    // portable.nsi が固有の $PLUGINSDIR/app に展開する(型コメントとは逆)。
    expect(config.portable.unpackDirName).toBe(true);
  });
  it("ships only the fixtures --fake needs, and they exist", async () => {
    expect(
      config.extraResources.find((r) => r.to === "fixtures"),
    ).toMatchObject({
      from: "test/fixtures/claude",
      to: "fixtures",
    });
    expect(
      config.extraResources.find((r) => r.to === "fixtures-codex"),
    ).toMatchObject({
      from: "test/fixtures/codex",
      to: "fixtures-codex",
    });
    expect(
      config.extraResources.find(
        (r) => r.to === "claude-sdk-seed/node_modules",
      ),
    ).toEqual({
      from: ".out/claude-sdk-seed/node_modules",
      to: "claude-sdk-seed/node_modules",
      filter: ["**/*"],
    });
    for (const resource of config.extraResources.filter(
      (r) => r.to === "fixtures" || r.to === "fixtures-codex",
    )) {
      for (const name of resource.filter)
        await expect(
          access(`${resource.from}/${name}`),
        ).resolves.toBeUndefined();
      expect(resource.filter.join()).not.toMatch(/credential|auth/i);
    }
  });
});
