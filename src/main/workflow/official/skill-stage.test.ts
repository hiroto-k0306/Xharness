import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  chmod,
  readFile,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { stageClaudeSkills } from "./skill-stage.js";
import type { OfficialSkillBundle } from "../../../shared/official-skills.js";
const stages: Awaited<ReturnType<typeof stageClaudeSkills>>[] = [];
afterEach(async () => {
  for (const stage of stages.splice(0)) await stage.cleanup();
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function bundle(
  body = "---\nname: sample\ndescription: Safe local example\n---\nRead references/guide.txt.",
  extra: [string, string][] = [
    ["references/guide.txt", "Unchanged local reference\r\n"],
  ],
): OfficialSkillBundle {
  const files = [["SKILL.md", body], ...extra]
    .map(([relativePath, body]) => ({
      relativePath: relativePath!,
      body: body!,
      hash: hash(body!),
    }))
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
  return {
    provider: "claude",
    scope: "project",
    name: "sample",
    source: "/selected/.claude/skills/sample/SKILL.md",
    hash: hash(body),
    bundleHash: hash(
      JSON.stringify(
        files.map(({ relativePath, hash }) => ({ relativePath, hash })),
      ),
    ),
    files,
  };
}
it("stages unchanged selected text only and removes its owned snapshot", async () => {
  const selected = bundle();
  const stage = await stageClaudeSkills([selected]);
  stages.push(stage);
  expect([...stage.names]).toEqual([["xharness-selected-0:sample", "sample"]]);
  const root = stage.plugins[0]!.path;
  const main = join(root, "skills/sample/SKILL.md"),
    reference = join(root, "skills/sample/references/guide.txt");
  expect(await readFile(main, "utf8")).toBe(
    selected.files.find((file) => file.relativePath === "SKILL.md")!.body,
  );
  expect(await readFile(reference, "utf8")).toBe(
    "Unchanged local reference\r\n",
  );
  expect(await stage.readable(reference, false)).toBe(true);
  expect(await stage.readable(join(root, "skills/sample"), true)).toBe(true);
  expect(
    await stage.readable(join(root, ".claude-plugin/plugin.json"), false),
  ).toBe(false);
  expect(await stage.readable(selected.source, false)).toBe(false);
  expect(stage.contains(root)).toBe(true);
  expect(stage.contains(stage.root + "-sibling/file.md")).toBe(false);
  await stage.cleanup();
  expect(await stat(stage.root).catch(() => undefined)).toBeUndefined();
});
it.each([
  "---\nname: sample\ndescription: Safe\nhooks: {}\n---\nBody",
  "---\nname: sample\ndescription: Safe\ncontext: fork\n---\nBody",
  "---\nname: sample\ndescription: Safe\nallowed-tools: [Bash]\n---\nBody",
  "---\nname: sample\ndescription: Safe\nmodel: other\n---\nBody",
  "---\nname: sample\ndescription: Safe\n---\n!`echo BAD`",
  "---\nname: sample\ndescription: Safe\n---\n```!\necho BAD\n```",
  "\ufeff---\nname: sample\ndescription: Safe\n---\nBody",
])(
  "rejects unsupported native behavior without rewriting it: %s",
  async (body) => {
    await expect(stageClaudeSkills([bundle(body)])).rejects.toThrow(
      "official-skill-stage-unsupported",
    );
  },
);
it.each([
  "../outside.md",
  ".claude/settings.md",
  "scripts/run.sh",
  "C:/outside.md",
])("rejects unsafe/unsupported bundle path %s", async (path) => {
  await expect(
    stageClaudeSkills([bundle(undefined, [[path, "data"]])]),
  ).rejects.toThrow();
});
it("rejects a changed body, parent digest, duplicate selection or oversized bundle", async () => {
  const changed = bundle();
  changed.files[0]!.body += "changed";
  await expect(stageClaudeSkills([changed])).rejects.toThrow();
  await expect(
    stageClaudeSkills([{ ...bundle(), bundleHash: "0".repeat(64) }]),
  ).rejects.toThrow();
  await expect(stageClaudeSkills([bundle(), bundle()])).rejects.toThrow();
  await expect(
    stageClaudeSkills([bundle(undefined, [["large.txt", "x".repeat(16384)]])]),
  ).rejects.toThrow();
});
it("denies changed staged files and linked references", async () => {
  const stage = await stageClaudeSkills([bundle()]);
  stages.push(stage);
  const file = join(
    stage.plugins[0]!.path,
    "skills/sample/references/guide.txt",
  );
  await chmod(file, 0o600);
  await writeFile(file, "changed");
  expect(await stage.readable(file, false)).toBe(false);
  await unlink(file);
  await symlink(join(stage.plugins[0]!.path, "skills/sample/SKILL.md"), file);
  expect(await stage.readable(file, false)).toBe(false);
});
