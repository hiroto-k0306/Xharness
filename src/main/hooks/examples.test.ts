import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parse } from "yaml";
import { type HookContext } from "../core/loop-types.js";
import { type Tool } from "../tools/registry.js";
import { hookSnapshot } from "./step-hooks.js";
import { parseShellHooks, shellHooks } from "./shell-hooks.js";
import { expandCommand, userCommands } from "../session/slash-commands.js";

const example = (path: string) =>
  new URL("../../../docs/examples/" + path, import.meta.url);
const context = (name: string, path: string): HookContext =>
  hookSnapshot({
    round: 1,
    messages: [],
    calls: [{ id: "test", name, input: { path } }],
  });
async function fixture(approved = true) {
  const document = parse(await readFile(example("hooks.yaml"), "utf8"));
  const hooks = parseShellHooks(document.hooks, true);
  const execute = vi.fn<Tool["execute"]>(async () => ({
    content: "offline format failure",
    isError: true,
  }));
  const bash: Tool = {
    spec: { name: "Bash", description: "in-process mock", inputSchema: {} },
    readOnly: false,
    validate: async () => undefined,
    execute,
  };
  const cwd = await mkdtemp(join(tmpdir(), "xh-examples-"));
  const runner = shellHooks({
    hooks,
    cwd,
    agent: "main",
    phase: () => "implement",
    bash,
    approve: async () => approved,
  });
  return { execute, cwd, runner };
}
const signal = () => new AbortController().signal;

it.each(["Write", "Edit", "MultiEdit"])(
  "the shipped protection example blocks %s before act without a shell",
  async (name) => {
    const { runner, execute } = await fixture();
    expect(
      await runner.beforeStep(
        "act",
        context(name, "migrations/001.sql"),
        signal(),
      ),
    ).toEqual({
      kind: "block",
      reason: "migrations/ は手で編集してください。",
    });
    expect(
      await runner.beforeStep("act", context(name, "src/a.ts"), signal()),
    ).toEqual({ kind: "continue" });
    expect(execute).not.toHaveBeenCalled();
  },
);
it("the shipped formatter selects TypeScript, quotes paths and injects failures", async () => {
  const { runner, execute } = await fixture();
  await runner.afterStep("act", context("Read", "src/a.ts"), signal());
  await runner.afterStep("act", context("Edit", "docs/a.md"), signal());
  expect(execute).not.toHaveBeenCalled();
  const path = "src/a';$(untrusted).tsx";
  expect(
    await runner.afterStep("act", context("MultiEdit", path), signal()),
  ).toEqual({
    kind: "inject",
    message: "format-typescript: offline format failure",
  });
  const input = execute.mock.calls[0]?.[0] as
    { command: string; timeoutSec: number } | undefined;
  expect(input?.command).toContain("--write -- 'src/a'';$(untrusted).tsx'");
  expect(input?.command).not.toContain("{{files}}");
  expect(input?.command).toContain("exit $LASTEXITCODE");
  expect(input?.timeoutSec).toBe(60);
});
it("the shipped formatter never executes when project approval is denied", async () => {
  const { runner, execute } = await fixture(false);
  expect(
    await runner.afterStep("act", context("Write", "src/a.ts"), signal()),
  ).toEqual({ kind: "stop", reason: "project_hooks_rejected" });
  expect(execute).not.toHaveBeenCalled();
});
it("the shipped Git commands require project trust and expand arguments literally", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-examples-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "xh-examples-project-"));
  const commands = join(cwd, ".xharness", "commands");
  await mkdir(commands, { recursive: true });
  for (const name of ["commit", "pr"]) {
    await copyFile(
      example("commands/" + name + ".md"),
      join(commands, name + ".md"),
    );
  }
  expect(await userCommands(home, cwd, false)).toEqual([]);
  const loaded = await userCommands(home, cwd, true);
  expect(loaded.map((c) => c.name)).toEqual(["commit", "pr"]);
  const args = "$&\n/pr $(untrusted)";
  for (const command of loaded) {
    expect(expandCommand("/" + command.name + " " + args, loaded)).toBe(
      command.body.replaceAll("$ARGUMENTS", () => args),
    );
    expect(expandCommand("/" + command.name, loaded)).toBe(
      command.body.replaceAll("$ARGUMENTS", ""),
    );
  }
});
