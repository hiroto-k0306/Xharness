import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat, realpath } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { type Tool, type ToolRegistry } from "./registry.js";
import { failure } from "./errors.js";

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
export function fileTools(access: FileAccess): ToolRegistry {
  const tools: ToolRegistry = new Map();
  for (const name of ["Read", "Write", "Edit"] as const) {
    const properties =
      name === "Read"
        ? { path: { type: "string" } }
        : name === "Write"
          ? { path: { type: "string" }, content: { type: "string" } }
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
          : ["path", "oldString", "newString"];
    const validate = async (input: unknown) => {
      try {
        const args = argumentsObject(input);
        if (Object.keys(args).some((k) => !required.includes(k)))
          return "Unknown argument";
        for (const key of required) stringArg(args, key);
        if (!stringArg(args, "path").trim()) return "Path is empty";
        if (name === "Edit" && !stringArg(args, "oldString"))
          return "oldString is empty";
        const path = await access.path(stringArg(args, "path"));
        if (name === "Edit" && !access.reads.has(path))
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
            ? "Read a UTF-8 file before editing it"
            : name === "Write"
              ? "Write a UTF-8 file; existing files require Read first"
              : "Replace exactly one occurrence in a previously read file",
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
            error: failure("invalid_args"),
          };
        const args = argumentsObject(input);
        const path = await access.path(stringArg(args, "path"));
        if (name === "Read") {
          const bytes = await readFile(path);
          const content = bytes.toString("utf8");
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
        let content = stringArg(
          args,
          name === "Write" ? "content" : "newString",
        );
        if (name === "Edit") {
          const original = await readFile(path, "utf8");
          const old = stringArg(args, "oldString");
          const first = original.indexOf(old);
          if (first < 0 || original.indexOf(old, first + 1) >= 0)
            return {
              content: "oldString must match exactly once",
              error: failure("invalid_args"),
              isError: true,
            };
          content =
            original.slice(0, first) +
            content +
            original.slice(first + old.length);
        }
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
        await writeFile(path, content, "utf8");
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
