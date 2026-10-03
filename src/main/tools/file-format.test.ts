import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileAccess, fileTools } from "./files.js";
const signal = () => new AbortController().signal;
it.each(["\n", "\r\n"])(
  "preserves %j and UTF-8 BOM through Edit and Write",
  async (newline) => {
    const cwd = await mkdtemp(join(tmpdir(), "xh-format-"));
    const path = join(cwd, "a.txt");
    const tools = fileTools(new FileAccess(cwd));
    await writeFile(path, `\ufeffalpha${newline}beta${newline}`);
    await tools.get("Read")!.execute({ path }, signal());
    expect(
      (
        await tools
          .get("Edit")!
          .execute(
            { path, oldString: "alpha\nbeta", newString: "one\r\ntwo" },
            signal(),
          )
      ).isError,
    ).toBeFalsy();
    expect(await readFile(path)).toEqual(
      Buffer.from(`\ufeffone${newline}two${newline}`),
    );
    await tools.get("Read")!.execute({ path }, signal());
    expect(
      (
        await tools
          .get("Write")!
          .execute({ path, content: "\ufeffthree\nfour\r\n" }, signal())
      ).isError,
    ).toBeFalsy();
    expect(await readFile(path)).toEqual(
      Buffer.from(`\ufeffthree${newline}four${newline}`),
    );
  },
);
it("does not introduce BOM into existing files and uses LF for new files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xh-format-"));
  const tools = fileTools(new FileAccess(cwd));
  await writeFile(join(cwd, "neighbor.txt"), "neighbor\r\n");
  await tools
    .get("Write")!
    .execute({ path: "new.txt", content: "one\r\ntwo\r\n" }, signal());
  expect(await readFile(join(cwd, "new.txt"), "utf8")).toBe("one\ntwo\n");
  await tools.get("Read")!.execute({ path: "new.txt" }, signal());
  await tools
    .get("Write")!
    .execute({ path: "new.txt", content: "\ufeffthree\r\n" }, signal());
  expect(await readFile(join(cwd, "new.txt"))).toEqual(Buffer.from("three\n"));
});
it("keeps untouched mixed newlines during Edit and defaults to LF when none exists", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xh-format-"));
  const tools = fileTools(new FileAccess(cwd));
  await writeFile(join(cwd, "mixed"), "a\r\nb\nc");
  await tools.get("Read")!.execute({ path: "mixed" }, signal());
  await tools
    .get("Edit")!
    .execute({ path: "mixed", oldString: "a", newString: "x\ny" }, signal());
  expect(await readFile(join(cwd, "mixed"), "utf8")).toBe("x\r\ny\r\nb\nc");
  await writeFile(join(cwd, "none"), "\ufeffplain");
  await tools.get("Read")!.execute({ path: "none" }, signal());
  await tools
    .get("Write")!
    .execute({ path: "none", content: "x\r\ny" }, signal());
  expect(await readFile(join(cwd, "none"), "utf8")).toBe("\ufeffx\ny");
});
it("accepts BOM copied from Read without duplicating or removing the file BOM", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xh-format-bom-"));
  const tools = fileTools(new FileAccess(cwd));
  const path = join(cwd, "a");
  await writeFile(path, "\ufeffold\r\n");
  await tools.get("Read")!.execute({ path }, signal());
  expect(
    (
      await tools
        .get("Edit")!
        .execute(
          { path, oldString: "\ufeffold\n", newString: "\ufeffnew\n" },
          signal(),
        )
    ).isError,
  ).toBeFalsy();
  expect(await readFile(path)).toEqual(Buffer.from("\ufeffnew\r\n"));
});
