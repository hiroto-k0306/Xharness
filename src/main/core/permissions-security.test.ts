// レビュー指摘(2026-10-02)の回帰テスト: 権限判定のすり抜け・作業フォルダ外の読み取り・保護パス。
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decidePermission,
  grantFor,
  type PermissionConfig,
} from "./permissions.js";
import {
  analyzeCommand,
  bashGrantPattern,
  subcommands,
} from "./shell-command.js";
import { isProtectedPath, isSecretPath } from "./sensitive-paths.js";

const call = (name: string, input: unknown) => ({ id: "t", name, input });
const bash = (command: string) => call("Bash", { command });
const plan: PermissionConfig = { mode: "plan", rules: [] };
const workspace = () => mkdtemp(join(tmpdir(), "xh-sec-"));

describe("PowerShell nested execution cannot slip through", () => {
  it.each([
    "git status (Remove-Item -Recurse -Force C:\\Users\\x)",
    "Get-Content (Invoke-WebRequest http://x)",
    "git log @(calc.exe)",
    "Get-ChildItem { calc }",
    "rg --pre calc.exe foo",
    "rg --pre=calc.exe foo",
    "git -c core.pager=calc.exe log",
    "git -C ..\\other status",
    "git diff --ext-diff",
    ". ./profile.ps1",
    "git log --format=$env:USERPROFILE",
  ])("plan mode denies %s", async (command) => {
    expect(await decidePermission(bash(command), plan, await workspace())).toBe(
      "deny",
    );
  });

  it("still allows plain read-only commands in plan mode", async () => {
    const cwd = await workspace();
    for (const command of [
      "git status",
      "git log --oneline",
      "rg needle src",
      "pwd",
    ])
      expect(await decidePermission(bash(command), plan, cwd)).toBe("allow");
  });

  it("asks (not allows) when a read-only command reads outside the workspace", async () => {
    const cwd = await workspace();
    for (const command of [
      "Get-Content C:\\Users\\x\\notes.txt",
      "Get-Content ..\\..\\notes.txt",
      "rg token ~/",
      "Get-ChildItem -Path:/etc",
      "Get-Content env:PATH",
    ])
      expect(await decidePermission(bash(command), plan, cwd)).toBe("ask");
  });

  it("an 'always' grant for git status does not approve nested or option-driven execution", async () => {
    const cwd = await workspace();
    const config: PermissionConfig = {
      mode: "default",
      rules: [grantFor(bash("git status"))],
    };
    expect(await decidePermission(bash("git status"), config, cwd)).toBe(
      "allow",
    );
    expect(await decidePermission(bash("git status -s"), config, cwd)).toBe(
      "allow",
    );
    for (const command of [
      "git log (Remove-Item -Recurse C:\\x)",
      "git status (Remove-Item -Recurse C:\\x)",
      "git -c core.pager=calc.exe status",
      "git log",
      "git push --force",
      "git status; calc.exe",
    ])
      expect(await decidePermission(bash(command), config, cwd)).toBe("ask");
  });

  it("a broad allow rule cannot approve compound or nested commands", async () => {
    const cwd = await workspace();
    const config: PermissionConfig = {
      mode: "default",
      rules: [{ tool: "Bash", decision: "allow" }],
    };
    expect(await decidePermission(bash("npm test"), config, cwd)).toBe("allow");
    for (const command of [
      "npm test; Remove-Item x",
      "npm test && calc",
      "npm test | Out-File x",
      "npm test > out.txt",
      "Write-Output $(calc)",
    ])
      expect(await decidePermission(bash(command), config, cwd)).toBe("ask");
  });

  it("deny and ask rules apply to any part of a compound or nested command", async () => {
    const cwd = await workspace();
    const config: PermissionConfig = {
      mode: "default",
      rules: [
        { tool: "Bash", pattern: "npm publish *", decision: "deny" },
        { tool: "Bash", decision: "allow" },
      ],
    };
    expect(
      await decidePermission(
        bash("npm test; npm publish --tag x"),
        config,
        cwd,
      ),
    ).toBe("deny");
    expect(
      await decidePermission(bash("Write-Output (npm publish)"), config, cwd),
    ).toBe("deny");
  });

  it("catches destructive commands even inside parentheses", async () => {
    const cwd = await workspace();
    const config: PermissionConfig = {
      mode: "acceptEdits",
      rules: [{ tool: "*", decision: "allow" }],
    };
    for (const command of [
      "Remove-Item -Recurse x",
      "ri x",
      "rd /s x",
      "Start-Process calc",
    ])
      expect(await decidePermission(bash(command), config, cwd)).toBe("ask");
  });
});

describe("grants are saved narrowly", () => {
  it.each([
    ["git status", "git status *"],
    ["git status -s", "git status *"],
    ["npm run build", "npm run *"],
    ["pwd", "pwd"],
    ["ls -la", "ls -la"],
    ["node C:\\tools\\x.js", "node C:\\tools\\x.js"],
    ["git -c a=b log", "git -c a=b log"],
    ["git status; calc", "git status; calc"],
  ])("%s → %s", (command, pattern) => {
    expect(bashGrantPattern(command)).toBe(pattern);
  });
  it("WebFetch grants cover one domain, not every URL", () => {
    expect(
      grantFor(call("WebFetch", { url: "https://docs.example.com/a/b?q=1" })),
    ).toEqual({
      tool: "WebFetch",
      pattern: "https://docs.example.com/*",
      decision: "allow",
    });
  });
});

describe("file tools outside the workspace and secret files", () => {
  it("asks before reading, grepping or globbing outside the workspace", async () => {
    const cwd = await workspace();
    const config: PermissionConfig = { mode: "default", rules: [] };
    for (const c of [
      call("Read", { path: "/root/.aws/credentials" }),
      call("Read", { path: "../neighbour/file.txt" }),
      call("Grep", { pattern: "x", path: "/etc" }),
      call("Glob", { pattern: "**/*", path: "/" }),
    ])
      expect(await decidePermission(c, config, cwd)).toBe("ask");
    expect(
      await decidePermission(call("Read", { path: "src/a.ts" }), config, cwd),
    ).toBe("allow");
    expect(
      await decidePermission(call("Glob", { pattern: "**/*.ts" }), config, cwd),
    ).toBe("allow");
  });
  it("an explicit allow rule can open a path outside; secrets still ask", async () => {
    const cwd = await workspace();
    const config: PermissionConfig = {
      mode: "default",
      rules: [{ tool: "Read", pattern: "/opt/docs/*", decision: "allow" }],
    };
    expect(
      await decidePermission(
        call("Read", { path: "/opt/docs/a.md" }),
        config,
        cwd,
      ),
    ).toBe("allow");
    expect(
      await decidePermission(
        call("Read", { path: "/opt/other.md" }),
        config,
        cwd,
      ),
    ).toBe("ask");
  });
  it.each([
    ".git-credentials",
    ".aws/credentials",
    ".ssh/config",
    "certs/server.pem",
    "deploy.key",
    ".npmrc",
    ".netrc",
    ".kube/config",
    ".docker/config.json",
    "id_ecdsa",
    ".env.production",
  ])("asks before reading %s inside the workspace", async (path) => {
    const cwd = await workspace();
    const config: PermissionConfig = {
      mode: "default",
      rules: [{ tool: "*", decision: "allow" }],
    };
    expect(await decidePermission(call("Read", { path }), config, cwd)).toBe(
      "ask",
    );
    expect(isSecretPath(path)).toBe(true);
  });
  it("does not treat ordinary files as secrets", () => {
    for (const path of [
      "src/key.ts",
      "docs/aws.md",
      "keys/README.md",
      "monkey.txt",
    ])
      expect(isSecretPath(path)).toBe(false);
  });
});

describe("protected paths (Claude Code compatible)", () => {
  it.each([
    ".xharness/config.yaml",
    ".git/hooks/pre-commit",
    ".vscode/settings.json",
    ".husky/pre-push",
    ".claude/settings.json",
    "sub/.gitmodules",
    ".npmrc",
    ".config/git/config",
  ])("acceptEdits + allow-all still asks before writing %s", async (path) => {
    const cwd = await workspace();
    const config: PermissionConfig = {
      mode: "acceptEdits",
      rules: [{ tool: "*", decision: "allow" }],
    };
    expect(await decidePermission(call("Write", { path }), config, cwd)).toBe(
      "ask",
    );
    expect(
      await decidePermission(call("Edit", { path }), config, cwd, {
        scratch: true,
      }),
    ).toBe("ask");
  });
  it("ordinary writes are still accepted in acceptEdits", async () => {
    const cwd = await workspace();
    expect(
      await decidePermission(
        call("Write", { path: "src/app.ts" }),
        { mode: "acceptEdits", rules: [] },
        cwd,
      ),
    ).toBe("allow");
  });
  it("a workspace that itself lives under ~/.xharness (worktree / scratch) is not protected as a whole", async () => {
    const base = await workspace();
    const cwd = join(base, ".xharness", "worktrees", "w1", "s1");
    await mkdir(cwd, { recursive: true });
    expect(
      await decidePermission(
        call("Write", { path: "src/app.ts" }),
        { mode: "acceptEdits", rules: [] },
        cwd,
      ),
    ).toBe("allow");
    expect(isProtectedPath("src/.xharness/x")).toBe(true);
  });
  it("detects a protected target reached through a junction inside the workspace", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, ".git"));
    await symlink(join(cwd, ".git"), join(cwd, "gitdir"), "junction");
    await writeFile(join(cwd, "gitdir", "HEAD"), "ref");
    expect(
      await decidePermission(
        call("Write", { path: "gitdir/HEAD" }),
        { mode: "acceptEdits", rules: [] },
        cwd,
      ),
    ).toBe("ask");
  });
});

describe("command analysis", () => {
  it("splits compound and nested commands for restrictive rules", () => {
    expect(subcommands("a; b | c && (d) $(e) @(f) {g}")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
    ]);
  });
  it("treats quotes as part of one token but never trusts unbalanced quotes", () => {
    expect(analyzeCommand("git commit -m 'a b'")).toMatchObject({
      simple: true,
      tokens: ["git", "commit", "-m", "a b"],
    });
    expect(analyzeCommand("git log 'unclosed").simple).toBe(false);
    expect(analyzeCommand("").simple).toBe(false);
  });
});
