import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileAccess, fileTools } from "./files.js";
it.each(["a.bat", "a.CMD", "a.txt"])(
  "creates %s with its intended newline",
  async (name) => {
    const cwd = await mkdtemp(join(tmpdir(), "xh-newline-"));
    const path = join(cwd, name);
    const result = await fileTools(new FileAccess(cwd))
      .get("Write")!
      .execute(
        { path, content: "echo 日本語\necho done\r\n" },
        new AbortController().signal,
      );
    expect(result.isError).toBeFalsy();
    const nl = name === "a.txt" ? "\n" : "\r\n";
    expect(await readFile(path, "utf8")).toBe(`echo 日本語${nl}echo done${nl}`);
  },
);
it.each(["none", "\n", "\r\n"])(
  "writes existing file with %j newlines",
  async (nl) => {
    const cwd = await mkdtemp(join(tmpdir(), "xh-newline-"));
    const path = join(cwd, "a.bat");
    await writeFile(path, "\ufeffold" + (nl === "none" ? "" : nl));
    const tools = fileTools(new FileAccess(cwd));
    await tools.get("Read")!.execute({ path }, new AbortController().signal);
    expect(
      (
        await tools
          .get("Write")!
          .execute(
            { path, content: "one\r\ntwo\n" },
            new AbortController().signal,
          )
      ).isError,
    ).toBeFalsy();
    expect(await readFile(path, "utf8")).toBe(
      "\ufeff" + (nl === "none" ? "one\r\ntwo\n" : `one${nl}two${nl}`),
    );
  },
);
