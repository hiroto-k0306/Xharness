import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileAccess, fileTools } from "./files.js";
import { UTF8_ERROR } from "./text-format.js";

const invalid = [
  Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]), // CP932: 日本語
  Buffer.concat([Buffer.from([255, 254]), Buffer.from("日本語", "utf16le")]),
  Buffer.from([254, 255, 0x65, 0xe5]),
  Buffer.from("text\0binary"),
  Buffer.from([0xc3, 0x28]),
];
it.each(invalid)(
  "rejects invalid text without changing bytes (%j)",
  async (bytes) => {
    const cwd = await mkdtemp(join(tmpdir(), "xh-encoding-"));
    const path = join(cwd, "a.txt");
    await writeFile(path, bytes);
    const access = new FileAccess(cwd);
    const tools = fileTools(access);
    for (const [name, args] of [
      ["Read", {}],
      ["Edit", { oldString: "text", newString: "changed" }],
      ["MultiEdit", { edits: [{ old: "text", new: "changed" }] }],
      ["Write", { content: "changed" }],
    ] as const) {
      const result = await tools
        .get(name)!
        .execute({ path, ...args }, new AbortController().signal);
      expect(result).toMatchObject({
        isError: true,
        content: UTF8_ERROR,
        error: { kind: "invalid_args", message: UTF8_ERROR },
      });
      expect(await readFile(path)).toEqual(bytes);
    }
  },
);
it.each(["", "\ufeff"])(
  "accepts UTF-8 with BOM=%j and both newlines",
  async (bom) => {
    for (const nl of ["\n", "\r\n"]) {
      const cwd = await mkdtemp(join(tmpdir(), "xh-encoding-"));
      const path = join(cwd, "a.txt");
      await writeFile(path, bom + "日本語" + nl);
      const tools = fileTools(new FileAccess(cwd));
      expect(
        (
          await tools
            .get("Read")!
            .execute({ path }, new AbortController().signal)
        ).isError,
      ).toBeFalsy();
      expect(
        (
          await tools
            .get("Edit")!
            .execute(
              { path, oldString: "日本語", newString: "変更" },
              new AbortController().signal,
            )
        ).isError,
      ).toBeFalsy();
      expect(await readFile(path, "utf8")).toBe(bom + "変更" + nl);
    }
  },
);
