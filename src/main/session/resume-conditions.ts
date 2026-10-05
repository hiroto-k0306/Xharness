import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadAgentConfig } from "../agents/definitions.js";
import { loadMainConfig } from "../config/config.js";
import { loadProjectConfig, projectMemory } from "../config/project.js";
import { loadModelCatalog } from "../config/model-catalog.js";
import { type ControllerContext } from "./context.js";
import { type StoredSession } from "./store.js";
export const resumeHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function bounded(path: string, limit = 1048576) {
  if ((await stat(path)).size > limit)
    throw new Error("Resume premise too large");
  return readFile(path, "utf8");
}
/** Read HEAD/reference/index without running git or repository-configured helpers. */
async function checkout(cwd: string) {
  let root = cwd;
  for (;;) {
    let markerFound = false;
    try {
      let git = join(root, ".git");
      const marker = await stat(git);
      markerFound = true;
      if (marker.isFile()) {
        const match = /^gitdir: (.+)\s*$/.exec(
          (await bounded(git, 4096)).trim(),
        );
        if (!match) throw new Error("Invalid git directory");
        git = resolve(root, match[1]!);
      }
      git = await realpath(git);
      const head = (await bounded(join(git, "HEAD"), 4096)).trim();
      let common = git;
      try {
        common = await realpath(
          resolve(git, (await bounded(join(git, "commondir"), 4096)).trim()),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      let commit = head;
      if (head.startsWith("ref: ")) {
        const ref = head.slice(5);
        if (!/^refs\/[\w./-]+$/.test(ref) || ref.split("/").includes(".."))
          throw new Error("Invalid git ref");
        try {
          commit = (await bounded(join(common, ref), 4096)).trim();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          try {
            commit =
              (await bounded(join(common, "packed-refs")))
                .split("\n")
                .find((line) => line.endsWith(` ${ref}`))
                ?.split(" ")[0] ?? "unborn";
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            commit = "unborn";
          }
        }
      }
      if (
        commit !== "unborn" &&
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)
      )
        throw new Error("Invalid git HEAD");
      let index: string | undefined;
      try {
        const path = join(git, "index");
        if ((await stat(path)).size > 4194304)
          throw new Error("Index too large");
        index = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return { root: await realpath(root), git, head, commit, index };
    } catch (error) {
      if (markerFound || (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
    }
    if (dirname(root) === root) return undefined;
    root = dirname(root);
  }
}
/** Persist hashes only. Fresh policies, memory and routing must agree after waiting. */
export async function resumeConditions(
  ctx: ControllerContext,
  session: StoredSession,
) {
  const root = ctx.workspaceRoot(session);
  if (session.workspaceId && !root) throw new Error("Missing workspace");
  const trusted = !root || (await ctx.trust.isTrusted(root));
  const project = await loadProjectConfig(ctx.options.home, root, { trusted });
  const main = await loadMainConfig(ctx.options.home, undefined, root);
  const agents = await loadAgentConfig(
    ctx.options.home,
    session.workspaceId ? session.cwd : undefined,
    trusted,
  );
  const cwd = await realpath(session.cwd);
  return resumeHash({
    cwd,
    root: root && (await realpath(root)),
    checkout: await checkout(cwd),
    session: {
      model: session.model,
      effort: session.effort,
      readOnly: session.readOnly,
      workspaceId: session.workspaceId,
      worktree: session.worktree,
      permissionMode: session.permissionMode,
    },
    project,
    main,
    agents,
    trusted,
    models: loadModelCatalog(),
    memory: ctx.clean(
      await projectMemory(
        ctx.options.home,
        session.workspaceId ? session.cwd : undefined,
        project.context.memoryFiles,
      ),
    ),
    fallback: ctx.options.fallback,
    aliases: ctx.options.aliases,
    web: ctx.options.web,
  });
}
