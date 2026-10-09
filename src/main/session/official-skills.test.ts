import {
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  symlink,
  link,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { OfficialSkills, OFFICIAL_SKILL_LIMITS } from "./official-skills.js";
import { parseOfficialSkillAction } from "../../shared/official-skills.js";

const folders: string[] = [];
it("pins ancestor identity and rejects a same-path directory exchange even with identical skill contents", async () => {
  const f = await fixture();
  await f.put("project");
  const reader = f.skills as unknown as {
    text(scope: "project", path: string): Promise<unknown>;
  };
  const original = reader.text.bind(reader);
  let reads = 0;
  vi.spyOn(reader, "text").mockImplementation(async (scope, path) => {
    const result = await original(scope, path);
    if (++reads === 2) {
      await rename(join(f.cwd, ".claude"), join(f.cwd, ".claude-before"));
      await f.put("project");
    }
    return result;
  });
  const preview = await f.skills.preview(f.source("project"));
  expect(preview.entry.eligible).toBe(false);
  expect(preview.entry.reasons.join()).toContain("祖先ディレクトリ");
  expect(preview.files).toBeUndefined();
});
it.each([false, true])(
  "keeps Windows CRLF and UTF-8 bytes in body/hash while comparing secret lines safely (BOM=%s)",
  async (bom) => {
    const f = await fixture();
    const text = (bom ? "\uFEFF" : "") + document().replaceAll("\n", "\r\n");
    await f.put("project", text);
    const preview = await f.skills.preview(f.source("project"));
    expect(preview.entry.eligible).toBe(true);
    expect(preview.entry.hash).toBe(
      createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
    );
    expect(
      preview.files?.find((file) => file.relativePath === "SKILL.md")?.body,
    ).toBe(text);
  },
);
it("accepts only canonical metadata-only IPC pins and rejects body/path/privilege injection", () => {
  const selection = {
    provider: "claude",
    scope: "project",
    name: "example",
    source: "/project/.claude/skills/example/SKILL.md",
    hash: "a".repeat(64),
    bundleHash: "b".repeat(64),
  };
  expect(parseOfficialSkillAction({ action: "select", selection })).toEqual({
    action: "select",
    selection,
  });
  expect(
    parseOfficialSkillAction({
      action: "preview",
      provider: "codex",
      source: "C:\\Project\\.agents\\skills\\example\\SKILL.md",
    }),
  ).toBeDefined();
  expect(parseOfficialSkillAction({ action: "clear" })).toEqual({
    action: "clear",
  });
  for (const invalid of [
    { action: "select", selection: { ...selection, body: "injected" } },
    { action: "select", selection: { ...selection, allowedTools: ["Bash"] } },
    { action: "select", selection: { ...selection, hash: "" } },
    { action: "select", selection: { ...selection, scope: "global" } },
    {
      action: "select",
      selection: { ...selection, source: "/project/../foreign/SKILL.md" },
    },
    { action: "preview", provider: "claude", source: "./SKILL.md" },
    { action: "preview", provider: "other", source: selection.source },
    { action: "list", provider: "claude", userRoot: "/foreign" },
    { action: "clear", selections: [] },
  ])
    expect(parseOfficialSkillAction(invalid)).toBeUndefined();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of folders.splice(0))
    await rm(path, { recursive: true, force: true });
});
const document = (extra = "", body = "Use the current project conventions.") =>
  `---\nname: example\ndescription: An offline example\n${extra}---\n${body}\n`;
async function fixture(provider: "claude" | "codex" = "claude") {
  const base = await mkdtemp(join(tmpdir(), "xh-official-skills-"));
  folders.push(base);
  const user = join(base, "user"),
    cwd = join(base, "project");
  await mkdir(user);
  await mkdir(cwd);
  const segment = provider === "claude" ? ".claude" : ".agents";
  const root = (scope: "user" | "project") =>
    join(scope === "user" ? user : cwd, segment, "skills");
  const source = (scope: "user" | "project") =>
    join(root(scope), "example", "SKILL.md");
  const put = async (
    scope: "user" | "project",
    body = document(),
    relativePath = "SKILL.md",
  ) => {
    const path = join(root(scope), "example", relativePath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
    return path;
  };
  return {
    base,
    user,
    cwd,
    root,
    source,
    put,
    skills: new OfficialSkills({ cwd, provider, baseUserHome: user }),
  };
}

it.each(["claude", "codex"] as const)(
  "discovers only fixed %s roots, keeps user/project identity and pins the complete text bundle",
  async (provider) => {
    const f = await fixture(provider);
    await f.put("user", document("user-invocable: true\n"));
    await f.put("project");
    await f.put("project", "Reference text", "references/日本語 手順.md");
    const foreign = join(
      f.user,
      provider === "claude" ? ".agents" : ".claude",
      "skills",
      "foreign",
    );
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, "SKILL.md"), document());
    const legacy = join(f.user, ".codex", "skills", "legacy");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "SKILL.md"), document());
    const catalog = await f.skills.list();
    expect(
      catalog.entries.map((entry) => [
        entry.scope,
        entry.provider,
        entry.eligible,
      ]),
    ).toEqual([
      ["user", provider, true],
      ["project", provider, true],
    ]);
    const entry = catalog.entries.find((e) => e.scope === "project")!;
    const preview = await f.skills.preview(entry.source);
    expect(preview.files?.map((file) => file.relativePath)).toEqual([
      "SKILL.md",
      "references/日本語 手順.md",
    ]);
    expect(await f.skills.select(entry)).toMatchObject({
      provider,
      scope: "project",
      name: "example",
      bundleHash: entry.bundleHash,
      files: preview.files,
    });
    expect(entry.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.bundleHash).toMatch(/^[a-f0-9]{64}$/);
  },
);

it("rejects changed, added and deleted bundle files at explicit selection and subsequent dispatch validation", async () => {
  const f = await fixture();
  await f.put("project");
  const entry = (await f.skills.list()).entries[0]!;
  await f.skills.select(entry);
  const asset = await f.put("project", "first", "references/note.txt");
  await expect(f.skills.select(entry)).rejects.toThrow("版が変わりました");
  const refreshed = (await f.skills.list()).entries[0]!;
  await writeFile(asset, "changed");
  await expect(f.skills.select(refreshed)).rejects.toThrow("版が変わりました");
  const refreshedAgain = (await f.skills.list()).entries[0]!;
  await rm(asset);
  await expect(f.skills.select(refreshedAgain)).rejects.toThrow(
    "版が変わりました",
  );
  await f.put("project", document("", "Changed main"));
  await expect(f.skills.select(entry)).rejects.toThrow("版が変わりました");
});

it.each([
  "hooks: {}\n",
  "context: fork\n",
  "model: opus\n",
  "effort: low\n",
  "allowed-tools: [Bash]\n",
  "user-invocable: false\n",
  "name: duplicate\n",
])(
  "keeps unsupported metadata visible with a reason and never makes it selectable: %s",
  async (extra) => {
    const f = await fixture();
    await f.put("project", document(extra));
    const entry = (await f.skills.list()).entries[0]!;
    expect(entry.eligible).toBe(false);
    expect(entry.reasons.length).toBeGreaterThan(0);
    await expect(f.skills.select(entry)).rejects.toThrow();
  },
);

it.each([
  "!`echo injected`",
  "```!\necho injected\n```",
  "~~~!\necho injected\n~~~",
])(
  "rejects dynamic command expansion without executing it: %s",
  async (body) => {
    const f = await fixture();
    await f.put("project", document("", body));
    const preview = await f.skills.preview(f.source("project"));
    expect(preview.entry.reasons.join()).toContain("動的command");
    expect(preview.files).toBeUndefined();
  },
);

it("rejects secret names/content, scripts and opaque files without exposing their bodies", async () => {
  const f = await fixture();
  await f.put("project");
  for (const [relativePath, body] of [
    [".env", "password=never-expose"],
    ["scripts/install.sh", "never execute"],
    ["images/a.png", "opaque"],
    ["references/note.tmp.md", "temporary draft"],
  ]) {
    const asset = await f.put("project", body!, relativePath!);
    const preview = await f.skills.preview(f.source("project"));
    expect(preview.entry.eligible).toBe(false);
    expect(preview.files).toBeUndefined();
    expect(JSON.stringify(preview)).not.toContain(body);
    await rm(asset);
  }
  await f.put("project", document("", "api_key=never-expose"));
  const preview = await f.skills.preview(f.source("project"));
  expect(preview.entry.reasons.join()).toContain("資格情報");
  expect(JSON.stringify(preview)).not.toContain("never-expose");
});

it("rejects file/directory links and hard links, foreign provider roots and forged scope", async () => {
  const f = await fixture();
  await f.put("project");
  const outside = join(f.base, "outside.md");
  await writeFile(outside, "outside");
  const linkPath = join(f.root("project"), "example", "linked.md");
  await symlink(outside, linkPath);
  expect((await f.skills.preview(f.source("project"))).entry.eligible).toBe(
    false,
  );
  await rm(linkPath);
  await link(outside, linkPath);
  expect((await f.skills.preview(f.source("project"))).entry.eligible).toBe(
    false,
  );
  await rm(linkPath);
  const entry = (await f.skills.list()).entries[0]!;
  await expect(
    f.skills.select({ ...entry, provider: "codex" }),
  ).rejects.toThrow("provider/scope");
  await expect(f.skills.select({ ...entry, scope: "user" })).rejects.toThrow(
    "provider/scope",
  );
  await expect(f.skills.preview(outside)).rejects.toThrow("ルート外");
  await rm(join(f.root("project"), "example"), { recursive: true });
  await symlink(
    f.user,
    join(f.root("project"), "example"),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect((await f.skills.list()).entries[0]?.eligible).toBe(false);
});

it("stops on UTF-8, file count and complete-bundle byte limits instead of truncating", async () => {
  const f = await fixture();
  await f.put("project");
  const asset = await f.put("project", "plain", "note.txt");
  await writeFile(asset, Buffer.from([0xff, 0xfe]));
  expect(
    (await f.skills.preview(f.source("project"))).entry.reasons.join(),
  ).toContain("非UTF-8");
  await writeFile(asset, "x".repeat(OFFICIAL_SKILL_LIMITS.totalBytes));
  expect(
    (await f.skills.preview(f.source("project"))).entry.reasons.join(),
  ).toContain("16KiB");
  await rm(asset);
  for (let i = 0; i < OFFICIAL_SKILL_LIMITS.files; i++)
    await f.put("project", "text", `note-${i}.txt`);
  expect(
    (await f.skills.preview(f.source("project"))).entry.reasons.join(),
  ).toContain("20ファイル");
});

it("detects a change after a file read before returning a selectable bundle", async () => {
  const f = await fixture();
  await f.put("project");
  const reader = f.skills as unknown as {
    text(scope: "project", path: string): Promise<unknown>;
  };
  const original = reader.text.bind(reader);
  let reads = 0;
  vi.spyOn(reader, "text").mockImplementation(async (scope, path) => {
    const result = await original(scope, path);
    if (++reads === 2)
      await f.put("project", document("", "changed during read"));
    return result;
  });
  const preview = await f.skills.preview(f.source("project"));
  expect(preview.entry.eligible).toBe(false);
  expect(preview.entry.reasons.join()).toContain("読取中に変更");
});
