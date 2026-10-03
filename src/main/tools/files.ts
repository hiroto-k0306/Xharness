import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  stat,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { resolve, dirname, basename, extname } from "node:path";
import {
  imageInfo,
  MAX_IMAGE_BYTES,
  IMAGE_ERROR,
} from "../../shared/images.js";
import { type Tool, type ToolRegistry } from "./registry.js";
import { failure } from "./errors.js";
import { textFormat, decodeText, UTF8_ERROR } from "./text-format.js";

export interface Snapshot {
  hash: string;
  modifiedAt: string;
}
export class FileAccess {
  readonly reads = new Map<string, Snapshot>();
  constructor(readonly cwd: string) {}
  async path(input: string): Promise<string> {
    const absolute = resolve(this.cwd, input);
    if (
      ["auth.json", ".credentials.json"].includes(
        basename(absolute).toLowerCase(),
      )
    )
      throw new Error("Credential files are unavailable to tools");
    // Canonical paths bind the read receipt to the actual target, including symlinks.
    try {
      const canonical = await realpath(absolute);
      if (
        ["auth.json", ".credentials.json"].includes(
          basename(canonical).toLowerCase(),
        )
      )
        throw new Error("Credential files are unavailable to tools");
      return process.platform === "win32" ? canonical.toLowerCase() : canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(absolute);
      if (parent === absolute) throw error;
      return resolve(await this.path(parent), basename(absolute));
    }
  }
  async snapshot(path: string): Promise<Snapshot> {
    const bytes = await readFile(path);
    const info = await stat(path);
    return {
      hash: createHash("sha256").update(bytes).digest("hex"),
      modifiedAt: info.mtime.toISOString(),
    };
  }
  async check(path: string): Promise<string | undefined> {
    let current: Snapshot;
    try {
      current = await this.snapshot(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return this.reads.has(path)
          ? "File disappeared; Read again before editing"
          : undefined;
      throw error;
    }
    const previous = this.reads.get(path);
    if (!previous) return "Read the existing file before writing or editing";
    if (
      previous.hash !== current.hash ||
      previous.modifiedAt !== current.modifiedAt
    )
      return "File changed; Read again before editing";
  }
}

type Args = Record<string, unknown>;
export function argumentsObject(value: unknown): Args {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Arguments must be an object");
  return value as Args;
}
export function stringArg(args: Args, key: string): string {
  if (typeof args[key] !== "string") throw new Error(`Invalid ${key}`);
  return args[key];
}
function editArguments(args: Args): { old: string; new: string }[] {
  if (!Array.isArray(args.edits) || !args.edits.length)
    throw new Error("edits is empty");
  return args.edits.map((value: unknown) => {
    const edit = argumentsObject(value);
    if (Object.keys(edit).some((key) => !["old", "new"].includes(key)))
      throw new Error("Unknown edit argument");
    const old = stringArg(edit, "old");
    if (!old) throw new Error("old is empty");
    return { old, new: stringArg(edit, "new") };
  });
}
export function fileTools(access: FileAccess): ToolRegistry {
  const tools: ToolRegistry = new Map();
  for (const name of ["Read", "Write", "Edit", "MultiEdit"] as const) {
    const properties =
      name === "Read"
        ? { path: { type: "string" } }
        : name === "Write"
          ? { path: { type: "string" }, content: { type: "string" } }
          : name === "MultiEdit"
            ? {
                path: { type: "string" },
                edits: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    properties: {
                      old: { type: "string", minLength: 1 },
                      new: { type: "string" },
                    },
                    required: ["old", "new"],
                    additionalProperties: false,
                  },
                },
              }
            : {
                path: { type: "string" },
                oldString: { type: "string" },
                newString: { type: "string" },
              };
    const required =
      name === "Read"
        ? ["path"]
        : name === "Write"
          ? ["path", "content"]
          : name === "MultiEdit"
            ? ["path", "edits"]
            : ["path", "oldString", "newString"];
    const validate = async (input: unknown) => {
      try {
        const args = argumentsObject(input);
        if (Object.keys(args).some((k) => !required.includes(k)))
          return "Unknown argument";
        for (const key of required) if (key !== "edits") stringArg(args, key);
        if (name === "MultiEdit") editArguments(args);
        if (!stringArg(args, "path").trim()) return "Path is empty";
        if (name === "Edit" && !stringArg(args, "oldString"))
          return "oldString is empty";
        const path = await access.path(stringArg(args, "path"));
        if (name !== "Read" || !/\.(png|jpe?g|gif|webp)$/i.test(path)) {
          try {
            if (decodeText(await readFile(path)) === undefined)
              return UTF8_ERROR;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        if (
          (name === "Edit" || name === "MultiEdit") &&
          !access.reads.has(path)
        )
          return "Read the existing file before editing";
        if (name !== "Read") return await access.check(path);
      } catch {
        return "Invalid file arguments or unavailable path";
      }
    };
    const tool: Tool = {
      invalidate: () => access.reads.clear(),
      spec: {
        name,
        description:
          name === "Read"
            ? "Read a UTF-8 file or PNG/JPEG/GIF/WebP image (max 5 MB, 8000px; no resizing) before editing it"
            : name === "Write"
              ? "Write a UTF-8 file; existing files require Read first. Preserve newline/BOM; newline-free existing files keep input newlines. New .bat/.cmd use CRLF; other new files use LF"
              : name === "MultiEdit"
                ? "Apply ordered edits to one previously read UTF-8 file atomically; each old must match exactly once in the result of preceding edits. Preserve newline/BOM; no write if any edit fails"
                : "Replace exactly one occurrence in a previously read UTF-8 file, preserving newline/BOM",
        inputSchema: {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        },
      },
      readOnly: name === "Read",
      validate,
      async execute(input, signal, context) {
        signal.throwIfAborted();
        const invalid = await validate(input);
        if (invalid)
          return {
            content: invalid,
            isError: true,
            error:
              invalid === UTF8_ERROR
                ? { kind: "invalid_args", message: UTF8_ERROR }
                : failure("invalid_args"),
          };
        const args = argumentsObject(input);
        const path = await access.path(stringArg(args, "path"));
        if (name === "Read") {
          const image = /\.(png|jpe?g|gif|webp)$/i.test(extname(path));
          if (image && (await stat(path)).size > MAX_IMAGE_BYTES)
            return {
              content: IMAGE_ERROR,
              isError: true,
              error: { kind: "invalid_args", message: IMAGE_ERROR },
            };
          const bytes = await readFile(path);
          if (image) {
            try {
              const info = imageInfo(bytes);
              return {
                content: JSON.stringify(info),
                blocks: [
                  {
                    type: "image",
                    mediaType: info.mediaType,
                    data: bytes.toString("base64"),
                  },
                ],
              };
            } catch {
              return {
                content: IMAGE_ERROR,
                isError: true,
                error: { kind: "invalid_args", message: IMAGE_ERROR },
              };
            }
          }
          const content = decodeText(bytes);
          if (content === undefined)
            return {
              content: UTF8_ERROR,
              isError: true,
              error: { kind: "invalid_args", message: UTF8_ERROR },
            };
          const info = await stat(path);
          const snapshot = {
            hash: createHash("sha256").update(bytes).digest("hex"),
            modifiedAt: info.mtime.toISOString(),
          };
          access.reads.set(path, snapshot);
          return {
            content: JSON.stringify({
              path,
              modifiedAt: snapshot.modifiedAt,
              content,
            }),
          };
        }
        let content =
          name === "MultiEdit"
            ? ""
            : stringArg(args, name === "Write" ? "content" : "newString");
        let original: string | undefined;
        try {
          original = decodeText(await readFile(path));
          if (original === undefined)
            return {
              content: UTF8_ERROR,
              isError: true,
              error: { kind: "invalid_args", message: UTF8_ERROR },
            };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const format = textFormat(original, path);
        if (name === "Edit" || name === "MultiEdit") {
          let body = format.body!;
          const edits =
            name === "MultiEdit"
              ? editArguments(args)
              : [{ old: stringArg(args, "oldString"), new: content }];
          for (const [index, edit] of edits.entries()) {
            const old = format.normalize(edit.old.replace(/^\ufeff/, ""));
            if (!old)
              return {
                content: "oldString must contain text other than BOM",
                isError: true,
                error: failure("invalid_args"),
              };
            const first = body.indexOf(old);
            if (first < 0 || body.indexOf(old, first + 1) >= 0)
              return {
                content: `Edit ${index + 1}: oldString must match exactly once${format.mixed ? "\nCRLFとLFが混在しています。oldStringを1行ずつに分けるか、行をまたがない範囲で指定してください。" : ""}`,
                error: failure("invalid_args"),
                isError: true,
              };
            body =
              body.slice(0, first) +
              format.normalize(
                first === 0 ? edit.new.replace(/^\ufeff/, "") : edit.new,
              ) +
              body.slice(first + old.length);
          }
          content = format.wrap(body);
        } else content = format.write(content);
        signal.throwIfAborted();
        const changed = await access.check(path);
        if (changed)
          return {
            content: changed,
            isError: true,
            error: failure("invalid_args"),
          };
        await context?.checkpoint?.beforeWrite(path);
        signal.throwIfAborted();
        const stale = await access.check(path);
        if (stale)
          return {
            content: stale,
            isError: true,
            error: failure("invalid_args"),
          };
        await mkdir(dirname(path), { recursive: true });
        if (name === "MultiEdit") {
          const temp = resolve(
            dirname(path),
            `.xharness-edit-${randomUUID()}.tmp`,
          );
          try {
            await writeFile(temp, content, {
              encoding: "utf8",
              flag: "wx",
              mode: (await stat(path)).mode,
            });
            signal.throwIfAborted();
            const changed = await access.check(path);
            if (changed)
              return {
                content: changed,
                isError: true,
                error: failure("invalid_args"),
              };
            await rename(temp, path);
          } finally {
            await rm(temp, { force: true });
          }
        } else await writeFile(path, content, "utf8");
        await context?.checkpoint?.afterWrite(
          path,
          Buffer.from(content, "utf8"),
        );
        // A new Read is required before the next mutation.
        access.reads.delete(path);
        return {
          content: JSON.stringify({
            path,
            modifiedAt: (await stat(path)).mtime.toISOString(),
          }),
        };
      },
    };
    tools.set(name, tool);
  }
  return tools;
}
