import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { type Tool, type ToolRegistry } from "../tools/registry.js";
import { runGit } from "../session/repository.js";

/** Session-local edits also provide a review diff for folders without Git. */
export class Changes {
  private readonly before = new Map<string, string | undefined>();
  readonly providers = new Set<"claude" | "codex">();
  constructor(readonly cwd: string) {}
  wrap(tools: ToolRegistry): ToolRegistry {
    return new Map(
      [...tools].map(([name, tool]) => [
        name,
        ["Write", "Edit", "MultiEdit"].includes(name)
          ? {
              ...tool,
              execute: async (
                input: unknown,
                signal: AbortSignal,
                context: Parameters<Tool["execute"]>[2],
              ) => {
                const path = resolve(
                  this.cwd,
                  String((input as { path?: unknown }).path),
                );
                if (!this.before.has(path)) {
                  try {
                    this.before.set(path, await readFile(path, "utf8"));
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                      throw error;
                    this.before.set(path, undefined);
                  }
                }
                return tool.execute(input, signal, context);
              },
            }
          : tool,
      ]),
    );
  }
  async diff(): Promise<string> {
    const chunks: string[] = [];
    for (const [path, original] of this.before) {
      let current: string | undefined;
      try {
        current = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (current !== original)
        chunks.push(
          `File: ${relative(this.cwd, path)}\n--- before\n${original}\n+++ after\n${current}`,
        );
    }
    return chunks.join("\n\n");
  }
}

export async function gitDiff(
  cwd: string,
  base: string,
  signal: AbortSignal,
): Promise<string> {
  const parts = await Promise.all([
    runGit(
      ["diff", "--no-ext-diff", "--no-textconv", `${base}...HEAD`],
      cwd,
      signal,
    ),
    runGit(["diff", "--no-ext-diff", "--no-textconv", "HEAD"], cwd, signal),
  ]);
  return parts.join("\n");
}
