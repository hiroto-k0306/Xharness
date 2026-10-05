import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { loadAgentConfig } from "./definitions.js";
import { childNeedsAsk } from "./permissions.js";
it("defaults to five review rounds without explicit settings", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-review-default-"));
  expect((await loadAgentConfig(home)).workflow.reviewRounds).toBe(5);
});
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
  const result = await loadAgentConfig(home, cwd, true);
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
it("an untrusted project cannot skip plan approval, but can still require it", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-agent-trust-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "xh-agent-trust-cwd-"));
  await mkdir(join(cwd, ".xharness"));
  await writeFile(
    join(cwd, ".xharness/config.yaml"),
    "workflow: {planApproval: auto, reviewRounds: 2}\n",
  );
  const untrusted = await loadAgentConfig(home, cwd);
  expect(untrusted.workflow.planApproval).toBe("ask");
  expect(untrusted.workflow.reviewRounds).toBe(2);
  expect((await loadAgentConfig(home, cwd, true)).workflow.planApproval).toBe(
    "auto",
  );
  // The user's own global setting is not a project grant.
  await writeFile(
    join(home, "config.yaml"),
    "workflow: {planApproval: auto}\n",
  );
  await writeFile(
    join(cwd, ".xharness/config.yaml"),
    "workflow: {reviewRounds: 2}\n",
  );
  expect((await loadAgentConfig(home, cwd)).workflow.planApproval).toBe("auto");
  // A project can always tighten a global `auto`.
  await writeFile(
    join(cwd, ".xharness/config.yaml"),
    "workflow: {planApproval: ask}\n",
  );
  expect((await loadAgentConfig(home, cwd)).workflow.planApproval).toBe("ask");
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
