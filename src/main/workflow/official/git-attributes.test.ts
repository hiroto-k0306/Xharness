import { afterEach, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  rm,
  rmdir,
  symlink,
  writeFile,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSafeGitAttributes,
  safeAttributeText,
} from "./git-attributes.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
});
it("allows only built-in text/eol/binary attributes", () => {
  expect(
    safeAttributeText(
      "# comment\n* text=auto eol=lf\n*.svg -text\n*.png binary\n*.cmd text eol=crlf\n",
    ),
  ).toBe(true);
  for (const value of [
    "* filter=probe",
    "* diff=driver",
    "* merge=driver",
    "* working-tree-encoding=UTF-16",
    "[attr]safe text",
    "* custom",
    "* !text",
    "* -filter",
    "* export-ignore",
    "* text\0",
  ])
    expect(safeAttributeText(value)).toBe(false);
});
it("checks nested, untracked and Git info attributes, refusing links and invalid encoding", async () => {
  const root = await mkdtemp(join(tmpdir(), "xh-safe-attrs-"));
  roots.push(root);
  const common = join(root, ".git");
  await mkdir(join(common, "info"), { recursive: true });
  await mkdir(join(root, "sub"));
  const attrs = join(root, "sub/.gitattributes"),
    info = join(common, "info/attributes");
  await writeFile(attrs, "* text=auto eol=lf\n");
  const check = () =>
    assertSafeGitAttributes(
      root,
      ["sub/.gitattributes"],
      common,
      new AbortController().signal,
    );
  await check();
  await writeFile(info, "* filter=probe\n");
  await expect(check()).rejects.toThrow("git-attributes-not-supported");
  await rm(info);
  await writeFile(attrs, Buffer.from([0xff, 0xfe]));
  await expect(check()).rejects.toThrow();
  await rm(attrs);
  await writeFile(join(root, "safe"), "* text\n");
  await link(join(root, "safe"), attrs);
  await expect(check()).rejects.toThrow();
  await rm(attrs);
  await rmdir(join(root, "sub"));
  const outside = await mkdtemp(join(tmpdir(), "xh-linked-attrs-"));
  roots.push(outside);
  await writeFile(join(outside, ".gitattributes"), "* text\n");
  await symlink(
    outside,
    join(root, "sub"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(check()).rejects.toThrow();
});
