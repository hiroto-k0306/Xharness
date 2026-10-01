import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { loadAgentConfig } from "./definitions.js";
import { childNeedsAsk } from "./permissions.js";
it("merges project agents and workflow settings without widening readonly tools", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-agent-config-"));
  const cwd = join(home, "project");
  await mkdir(join(cwd, ".xharness"), { recursive: true });
  await writeFile(
    join(home, "config.yaml"),
    "workflow: {mode: always, reviewRounds: 3}\n",
  );
  await writeFile(
    join(cwd, ".xharness/config.yaml"),
    "workflow: {planApproval: auto, worktrees: false}\nagents:\n  explorer: {model: codex:luna, effort: low, tools: [Read, Glob]}\n",
  );
  const result = await loadAgentConfig(home, cwd);
  expect(result.workflow).toMatchObject({
    mode: "always",
    reviewRounds: 3,
    planApproval: "auto",
    worktrees: false,
  });
  expect(result.agents.explorer?.model).toBe("codex:luna");
  await writeFile(
    join(cwd, ".xharness/config.yaml"),
    "agents:\n  bad: {model: claude:sonnet, tools: [Write]}\n",
  );
  await expect(loadAgentConfig(home, cwd)).rejects.toThrow("readonly");
});
it("planned globs cover Windows-relative files, while out-of-plan writes and Bash ask", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xh-agent-globs-"));
  const context = {
    id: "test",
    name: "worker",
    cwd,
    files: ["src/**/*.{ts,tsx}"],
  };
  expect(
    await childNeedsAsk(
      { id: "1", name: "Write", input: { path: "src/a.ts" } },
      context,
    ),
  ).toBe(false);
  expect(
    await childNeedsAsk(
      { id: "1", name: "Edit", input: { path: "other.txt" } },
      context,
    ),
  ).toBe(true);
  expect(
    await childNeedsAsk(
      { id: "1", name: "Bash", input: { command: "pnpm test" } },
      context,
    ),
  ).toBe(true);
});
