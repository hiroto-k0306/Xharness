import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadProjectConfig } from "./project.js";
it("defaults to 30 days and applies positive user retention without accepting repository overrides", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-retention-"));
  const cwd = join(home, "repo");
  await mkdir(join(cwd, ".xharness"), { recursive: true });
  await writeFile(
    join(cwd, ".xharness", "config.yaml"),
    "checkpoints:\n  retentionDays: 1\n",
  );
  expect(
    (await loadProjectConfig(home, cwd, { trusted: true })).checkpoints
      ?.retentionDays,
  ).toBe(30);
  for (const value of [45, 0, -1, 1.5]) {
    await writeFile(
      join(home, "config.yaml"),
      `checkpoints:\n  retentionDays: ${value}\n`,
    );
    expect(
      (await loadProjectConfig(home, cwd)).checkpoints?.retentionDays,
    ).toBe(value === 45 ? 45 : 30);
  }
});
