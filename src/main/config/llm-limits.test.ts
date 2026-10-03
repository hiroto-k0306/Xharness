import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadProjectConfig } from "./project.js";

it("defaults to unlimited and only accepts user limits, including in trusted workspaces", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-limits-"));
  const cwd = join(home, "repo");
  await mkdir(join(cwd, ".xharness"), { recursive: true });
  await writeFile(
    join(cwd, ".xharness", "config.yaml"),
    "limits: {llmCallsPerTurn: 99}\n",
  );
  expect(
    (await loadProjectConfig(home, cwd, { trusted: true })).limits,
  ).toEqual({ llmCallsPerTurn: 0, llmCallsPerSession: 0 });
  await writeFile(
    join(home, "config.yaml"),
    "limits: {llmCallsPerTurn: 2, llmCallsPerSession: 10}\n",
  );
  expect(
    (await loadProjectConfig(home, cwd, { trusted: true })).limits,
  ).toEqual({ llmCallsPerTurn: 2, llmCallsPerSession: 10 });
});
it.each([
  "{llmCallsPerTurn: -1}",
  "{llmCallsPerSession: 0.5}",
  "{llmCallsPerTurn: '2'}",
  "[]",
  "null",
  "true",
])(
  "rejects invalid limits %s instead of silently disabling the cap",
  async (value) => {
    const home = await mkdtemp(join(tmpdir(), "xh-limits-invalid-"));
    await writeFile(join(home, "config.yaml"), `limits: ${value}\n`);
    await expect(loadProjectConfig(home)).rejects.toThrow("0以上の整数");
  },
);
