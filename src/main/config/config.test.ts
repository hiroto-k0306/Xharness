import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadMainConfig,
  parseStartupArgs,
  resolveModel,
  resolveStartup,
} from "./config.js";

async function homeWith(yaml?: string) {
  const home = await mkdtemp(join(tmpdir(), "xh-cfg-"));
  if (yaml !== undefined) await writeFile(join(home, "config.yaml"), yaml);
  return home;
}

describe("main model from config (DESIGN §12)", () => {
  it("defaults to claude:opus / high when there is no config file", async () => {
    const cfg = await loadMainConfig(await homeWith());
    expect(cfg.choice).toEqual({
      provider: "claude",
      model: "claude-opus-5-5",
      effort: "high",
    });
    expect(cfg.warnings).toEqual([]);
  });
  it("reads main.model and main.effort, resolving aliases", async () => {
    const cfg = await loadMainConfig(
      await homeWith("main:\n  model: claude:sonnet\n  effort: max\n"),
    );
    expect(cfg.choice).toEqual({
      provider: "claude",
      model: "claude-sonnet-5-5",
      effort: "max",
    });
  });
  it("uses aliases defined in the file", async () => {
    const cfg = await loadMainConfig(
      await homeWith(
        "aliases:\n  fast: claude-haiku-4-5\nmain:\n  model: fast\n",
      ),
    );
    expect(cfg.choice.model).toBe("claude-haiku-4-5");
  });
  it("falls back to defaults with a warning for bad values or broken YAML", async () => {
    const bad = await loadMainConfig(
      await homeWith("main:\n  model: claude:gpt-6\n  effort: turbo\n"),
    );
    expect(bad.choice).toMatchObject({
      model: "claude-opus-5-5",
      effort: "high",
    });
    expect(bad.warnings).toHaveLength(2);
    const broken = await loadMainConfig(await homeWith("main: [unclosed"));
    expect(broken.choice.model).toBe("claude-opus-5-5");
    expect(broken.warnings).toHaveLength(1);
  });
  it("resolves provider:alias, bare alias and full ids, and rejects mismatches", () => {
    expect(resolveModel("claude:opus")?.model).toBe("claude-opus-5-5");
    expect(resolveModel("opus")?.model).toBe("claude-opus-5-5");
    expect(resolveModel("claude-haiku-4-5")).toEqual({
      provider: "claude",
      model: "claude-haiku-4-5",
    });
    expect(resolveModel("codex:sol")).toEqual({
      provider: "codex",
      model: "gpt-6.1-sol",
    });
    for (const bad of ["", "claude:", "other:opus", "claude:gpt-6.1-sol"])
      expect(resolveModel(bad)).toBeUndefined();
  });
});

describe("startup precedence", () => {
  const supported = ["claude"] as const;
  it("--model beats the config file; --effort beats main.effort", async () => {
    const home = await homeWith(
      "main:\n  model: claude:sonnet\n  effort: low\n",
    );
    const r = await resolveStartup({
      home,
      cliModel: "haiku",
      cliEffort: "xhigh",
      supported,
    });
    expect(r.choice).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      effort: "xhigh",
    });
  });
  it("uses the config file when no flags are given", async () => {
    const home = await homeWith("main:\n  model: sonnet\n");
    expect((await resolveStartup({ home, supported })).choice.model).toBe(
      "claude-sonnet-5-5",
    );
  });
  it("falls back to claude:opus when the config names a provider this build lacks", async () => {
    const home = await homeWith("main:\n  model: codex:sol\n");
    const r = await resolveStartup({ home, supported });
    expect(r.choice.model).toBe("claude-opus-5-5");
    expect(r.warnings.join()).toContain("codex");
  });
  it("rejects an unusable --model or --effort instead of silently ignoring it", async () => {
    const home = await homeWith();
    await expect(
      resolveStartup({ home, cliModel: "nope:x", supported }),
    ).rejects.toThrow();
    await expect(
      resolveStartup({ home, cliModel: "codex:sol", supported }),
    ).rejects.toThrow();
    await expect(
      resolveStartup({ home, cliEffort: "turbo", supported }),
    ).rejects.toThrow();
  });
  it("parses --fake / --model / --effort in both spellings", () => {
    expect(parseStartupArgs(["--fake"])).toEqual({
      fake: true,
      devtools: false,
    });
    expect(parseStartupArgs(["--devtools"]).devtools).toBe(true);
    expect(parseStartupArgs(["--model", "opus", "--effort=low"])).toMatchObject(
      {
        fake: false,
        model: "opus",
        effort: "low",
      },
    );
    expect(parseStartupArgs(["--model=claude:sonnet"]).model).toBe(
      "claude:sonnet",
    );
    expect(parseStartupArgs([]).model).toBeUndefined();
  });
});
