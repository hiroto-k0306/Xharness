// プロジェクト設定の信頼(Claude Code の workspace trust)とメモリファイルの範囲の回帰テスト。
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectConfig, projectMemory, saveRule } from "./project.js";
import { localRulesPath, WorkspaceTrust } from "./trust.js";

async function setup(projectYaml: string) {
  const home = await mkdtemp(join(tmpdir(), "xh-home-"));
  const root = await mkdtemp(join(tmpdir(), "xh-repo-"));
  await mkdir(join(root, ".xharness"));
  await writeFile(join(root, ".xharness", "config.yaml"), projectYaml);
  return { home, root };
}
const granting =
  "permissions:\n  mode: acceptEdits\n  rules:\n    - {tool: Bash, decision: allow}\n    - {tool: Bash, pattern: 'npm publish *', decision: deny}\n    - {tool: WebFetch, decision: ask}\n";

describe("project settings need workspace trust to grant capability", () => {
  it("holds back allow rules and acceptEdits until the workspace is trusted", async () => {
    const { home, root } = await setup(granting);
    const cfg = await loadProjectConfig(home, root);
    expect(cfg.permissions.mode).toBe("default");
    expect(cfg.permissions.rules).toEqual([
      { tool: "Bash", pattern: "npm publish *", decision: "deny" },
      { tool: "WebFetch", decision: "ask" },
    ]);
    expect(cfg.untrusted).toEqual({
      rules: [{ tool: "Bash", decision: "allow" }],
      mode: "acceptEdits",
    });
  });
  it("applies everything once trusted", async () => {
    const { home, root } = await setup(granting);
    const cfg = await loadProjectConfig(home, root, { trusted: true });
    expect(cfg.permissions.mode).toBe("acceptEdits");
    expect(cfg.permissions.rules).toHaveLength(3);
    expect(cfg.untrusted).toBeUndefined();
  });
  it("applies restricting settings (plan mode, deny/ask) without trust", async () => {
    const { home, root } = await setup(
      "permissions:\n  mode: plan\n  rules: [{tool: Read, decision: deny}]\n",
    );
    const cfg = await loadProjectConfig(home, root);
    expect(cfg.permissions.mode).toBe("plan");
    expect(cfg.permissions.rules).toEqual([{ tool: "Read", decision: "deny" }]);
    expect(cfg.untrusted).toBeUndefined();
  });
  it("never gates the user's own config", async () => {
    const home = await mkdtemp(join(tmpdir(), "xh-home-"));
    await writeFile(
      join(home, "config.yaml"),
      "permissions:\n  mode: acceptEdits\n  rules: [{tool: Bash, decision: allow}]\n",
    );
    const cfg = await loadProjectConfig(home);
    expect(cfg.permissions.mode).toBe("acceptEdits");
    expect(cfg.permissions.rules).toHaveLength(1);
  });
  it("remembers trust per folder, including through another spelling of the path", async () => {
    const { home, root } = await setup(granting);
    const trust = new WorkspaceTrust(home);
    expect(await trust.isTrusted(root)).toBe(false);
    await trust.trust(root);
    const alias = join(await mkdtemp(join(tmpdir(), "xh-alias-")), "link");
    await symlink(root, alias, "junction");
    const again = new WorkspaceTrust(home);
    expect(await again.isTrusted(alias)).toBe(true);
    expect(
      await again.isTrusted(await mkdtemp(join(tmpdir(), "xh-other-"))),
    ).toBe(false);
  });
});

describe("'always' grants stay with the user, scoped to one workspace", () => {
  it("saves outside the repository and applies only to that workspace", async () => {
    const { home, root } = await setup("context: {}\n");
    const other = await mkdtemp(join(tmpdir(), "xh-repo2-"));
    await saveRule(
      home,
      { tool: "Bash", pattern: "npm test *", decision: "allow" },
      root,
    );
    expect(await readdir(join(root, ".xharness"))).toEqual(["config.yaml"]);
    expect(await readFile(await localRulesPath(home, root), "utf8")).toContain(
      "npm test *",
    );
    expect(
      (await loadProjectConfig(home, root)).permissions.rules,
    ).toContainEqual({
      tool: "Bash",
      pattern: "npm test *",
      decision: "allow",
    });
    expect((await loadProjectConfig(home, other)).permissions.rules).toEqual(
      [],
    );
  });
});

describe("memory files stay inside the workspace and home", () => {
  it("reads normal memory files but not files outside, absolute paths or secrets", async () => {
    const home = await mkdtemp(join(tmpdir(), "xh-home-"));
    const parent = await mkdtemp(join(tmpdir(), "xh-parent-"));
    const cwd = join(parent, "repo");
    await mkdir(join(cwd, "docs"), { recursive: true });
    await writeFile(join(cwd, "AGENTS.md"), "project rules");
    await writeFile(join(cwd, "docs", "notes.md"), "nested notes");
    await writeFile(join(parent, "outside.txt"), "OUTSIDE-SECRET");
    await writeFile(join(cwd, "deploy.pem"), "PEM-SECRET");
    await symlink(parent, join(cwd, "escape"), "junction");
    const text = await projectMemory(home, cwd, [
      "AGENTS.md",
      "docs/notes.md",
      "../outside.txt",
      join(parent, "outside.txt"),
      "escape/outside.txt",
      "deploy.pem",
    ]);
    expect(text).toContain("project rules");
    expect(text).toContain("nested notes");
    expect(text).not.toContain("OUTSIDE-SECRET");
    expect(text).not.toContain("PEM-SECRET");
  });
  it("reads the global memory file from home", async () => {
    const home = await mkdtemp(join(tmpdir(), "xh-home-"));
    await writeFile(join(home, "AGENTS.md"), "global rules");
    expect(await projectMemory(home, undefined, ["AGENTS.md"])).toContain(
      "global rules",
    );
  });
});
