import { mkdtemp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { builtinCommands } from "../../shared/commands.js";
import {
  costSummary,
  expandCommand,
  initAgents,
  userCommands,
} from "./slash-commands.js";
import { unlimitedCalls } from "../../shared/llm-calls.js";

it("hides untrusted project commands, prioritizes trusted project definitions and reserves built-ins", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-commands-"));
  const cwd = await mkdtemp(join(tmpdir(), "xh-project-"));
  await mkdir(join(home, "commands"));
  await mkdir(join(cwd, ".xharness", "commands"), { recursive: true });
  await writeFile(join(home, "commands", "check.md"), "user: $ARGUMENTS");
  await writeFile(
    join(cwd, ".xharness", "commands", "check.md"),
    "project: $ARGUMENTS / $ARGUMENTS",
  );
  await writeFile(join(home, "commands", "clear.md"), "override");
  await writeFile(join(home, "commands", "mcp__bad.md"), "override");
  await writeFile(join(home, "commands", "empty.md"), " ");
  await writeFile(
    join(home, "commands", "large.md"),
    "x".repeat(1024 * 1024 + 1),
  );
  expect(await userCommands(home, cwd)).toEqual([
    { name: "check", body: "user: $ARGUMENTS", source: "user" },
  ]);
  expect(
    expandCommand("/check $&\nnext", await userCommands(home, cwd, true)),
  ).toBe("project: $&\nnext / $&\nnext");
  expect(expandCommand("/check", await userCommands(home))).toBe("user: ");
  expect(expandCommand("/missing", await userCommands(home))).toBeUndefined();
  expect(builtinCommands.map((c) => c.value)).toEqual(
    expect.arrayContaining([
      "/clear",
      "/resume",
      "/model",
      "/cost",
      "/init",
      "/mode",
      "/stop",
      "/compact",
      "/mcp",
    ]),
  );
});
it("does not load definitions through a linked command folder", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-commands-link-"));
  const target = await mkdtemp(join(tmpdir(), "xh-commands-target-"));
  await writeFile(join(target, "outside.md"), "outside");
  await symlink(
    target,
    join(home, "commands"),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(await userCommands(home)).toEqual([]);
});
it("init creates a template exclusively and never writes in plan mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xh-init-"));
  expect(await initAgents(cwd, true)).toMatchObject({ ok: false });
  await expect(readFile(join(cwd, "AGENTS.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await initAgents(cwd, false)).toEqual({ ok: true });
  const before = await readFile(join(cwd, "AGENTS.md"), "utf8");
  expect(before).toContain("## 開発・検証");
  expect(await initAgents(cwd, false)).toMatchObject({ ok: false });
  expect(await readFile(join(cwd, "AGENTS.md"), "utf8")).toBe(before);
});
it("cost distinguishes actual and fake calls, includes child usage without inventing a price", () => {
  const calls = {
    ...unlimitedCalls,
    turn: 4,
    session: 8,
    simulatedTurn: 1,
    simulatedSession: 2,
    since: 0,
  };
  expect(
    costSummary(calls, [
      {
        id: "#1",
        sessionId: "s",
        ts: 0,
        provider: "claude",
        kind: "model_call",
        agentId: "child",
        durationMs: 0,
        summary: "",
        usage: { inputTokens: 11, outputTokens: 7 },
      },
    ]),
  ).toContain("入力 11、出力 7");
  expect(costSummary(calls, [])).toContain("今ターン 3、セッション 6");
});
