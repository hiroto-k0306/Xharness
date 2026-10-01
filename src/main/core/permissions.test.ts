import { mkdtemp, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decidePermission,
  grantFor,
  type PermissionMode,
  type Rule,
} from "./permissions.js";
import {
  loadProjectConfig,
  projectMemory,
  saveRule,
} from "../config/project.js";
const call = (name: string, input: unknown) => ({ id: "test", name, input });
describe("Phase 4 permission rules", () => {
  it.each([
    ["default", "Read", "allow"],
    ["default", "Write", "ask"],
    ["acceptEdits", "Write", "allow"],
    ["plan", "Edit", "deny"],
    ["plan", "Read", "allow"],
    ["default", "WebSearch", "ask"],
  ])("%s / %s yields %s", async (mode, name, expected) => {
    const cwd = await mkdtemp(join(tmpdir(), "xh-perm-"));
    expect(
      await decidePermission(
        call(name, { path: "file" }),
        { mode: mode as PermissionMode, rules: [] },
        cwd,
      ),
    ).toBe(expected);
  });
  it("never lets broad allow override deny, outside writes, secrets or dangerous commands", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "xh-perm-"));
    const config = {
      mode: "acceptEdits" as const,
      rules: [{ tool: "*", decision: "allow" as const }],
    };
    expect(
      await decidePermission(
        call("Write", { path: "../outside.txt" }),
        config,
        cwd,
      ),
    ).toBe("ask");
    expect(
      await decidePermission(call("Read", { path: ".env" }), config, cwd),
    ).toBe("ask");
    expect(
      await decidePermission(
        call("Bash", { command: "git reset --hard" }),
        config,
        cwd,
      ),
    ).toBe("ask");
    expect(
      await decidePermission(
        call("Read", { path: "file" }),
        {
          ...config,
          rules: [...config.rules, { tool: "Read", decision: "deny" }],
        },
        cwd,
      ),
    ).toBe("deny");
    expect(
      await decidePermission(call("Write", { path: "file" }), config, cwd, {
        readOnly: true,
      }),
    ).toBe("deny");
  });
  it("detects writes through a workspace junction", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "xh-junction-"));
    const outside = await mkdtemp(join(tmpdir(), "xh-outside-"));
    await symlink(outside, join(cwd, "link"), "junction");
    expect(
      await decidePermission(
        call("Write", { path: "link/new.txt" }),
        { mode: "acceptEdits", rules: [] },
        cwd,
      ),
    ).toBe("ask");
  });
  it("asks for secrets reached by a junction and chained shell commands even with an allow rule", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "xh-secret-junction-"));
    const outside = await mkdtemp(join(tmpdir(), "xh-secret-target-"));
    await writeFile(join(outside, ".env"), "fixture secret");
    await symlink(outside, join(cwd, "link"), "junction");
    const config = {
      mode: "default" as const,
      rules: [{ tool: "*", decision: "allow" as const }],
    };
    expect(
      await decidePermission(
        call("Bash", { command: "Set-Content '.env' secret" }),
        { mode: "plan", rules: [] },
        cwd,
      ),
    ).toBe("deny");
    expect(
      await decidePermission(
        call("Bash", { command: "Get-Content '.env'" }),
        { mode: "plan", rules: [] },
        cwd,
      ),
    ).toBe("ask");
    expect(
      await decidePermission(
        call("Grep", { path: "link/.env", pattern: "." }),
        config,
        cwd,
      ),
    ).toBe("ask");
    expect(
      await decidePermission(
        call("Bash", { command: "git status; Set-Content ../file x" }),
        config,
        cwd,
      ),
    ).toBe("ask");
    expect(
      await decidePermission(
        call("Bash", { command: "git diff --ext-diff" }),
        { mode: "plan", rules: [] },
        cwd,
      ),
    ).toBe("deny");
    expect(
      await decidePermission(
        call("Bash", { command: "git status" }),
        { mode: "plan", rules: [] },
        cwd,
      ),
    ).toBe("allow");
  });
  it("limits plan shell commands and token grants without matching gitfake", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "xh-perm-"));
    const grants = [grantFor(call("Bash", { command: "git status" }))];
    for (const [command, expected] of [
      ["git status", "allow"],
      ["gitfake status", "ask"],
      ["git clean -fd", "ask"],
    ])
      expect(
        await decidePermission(
          call("Bash", { command }),
          { mode: "default", rules: grants },
          cwd,
        ),
      ).toBe(expected);
    expect(
      await decidePermission(
        call("Bash", { command: "git status; Write-Output test" }),
        { mode: "plan", rules: grants },
        cwd,
      ),
    ).toBe("deny");
    expect(
      await decidePermission(
        call("Bash", { command: "npm install" }),
        { mode: "plan", rules: grants },
        cwd,
      ),
    ).toBe("deny");
  });
  it("permits scratch edits while still asking outside scratch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "xh-perm-"));
    expect(
      await decidePermission(
        call("Write", { path: "file" }),
        { mode: "default", rules: [] },
        cwd,
        { scratch: true },
      ),
    ).toBe("allow");
    expect(
      await decidePermission(
        call("Write", { path: "../file" }),
        { mode: "default", rules: [] },
        cwd,
        { scratch: true },
      ),
    ).toBe("ask");
  });
  it("merges project rules after global ones and serializes persistent grants without destroying main config", async () => {
    const home = await mkdtemp(join(tmpdir(), "xh-config-"));
    const cwd = await mkdtemp(join(tmpdir(), "xh-project-"));
    await mkdir(join(cwd, ".xharness"));
    await writeFile(
      join(home, "config.yaml"),
      'main: {model: "codex:luna"}\npermissions:\n  rules: [{tool: Bash, decision: allow}]\n',
    );
    await writeFile(
      join(cwd, ".xharness/config.yaml"),
      "permissions:\n  mode: plan\n  rules: [{tool: Bash, decision: deny}]\ncontext: {compactThreshold: 0.7, memoryFiles: [AGENTS.md]}\n",
    );
    const cfg = await loadProjectConfig(home, cwd);
    expect(cfg.permissions.mode).toBe("plan");
    expect(cfg.permissions.rules).toHaveLength(2);
    expect(cfg.context.compactThreshold).toBe(0.7);
    const more: Rule[] = [
      { tool: "Read", decision: "allow" },
      { tool: "Grep", decision: "allow" },
    ];
    await Promise.all(more.map((r) => saveRule(home, r)));
    expect((await loadProjectConfig(home)).permissions.rules).toHaveLength(3);
    expect(await readFile(join(home, "config.yaml"), "utf8")).toContain(
      "codex:luna",
    );
    await writeFile(join(home, "AGENTS.md"), "global instructions");
    await writeFile(join(cwd, "AGENTS.md"), "project instructions");
    expect(await projectMemory(home, cwd, ["AGENTS.md"])).toContain(
      "project instructions",
    );
    expect(await projectMemory(home, undefined, ["AGENTS.md"])).not.toContain(
      "project instructions",
    );
  });
});
