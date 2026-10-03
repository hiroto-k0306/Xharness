// repository タブと worktree(§18.2, §18.3)の操作。Git の実処理は Repository が持つ。
import { type CommandResult, type HarnessCommand } from "../../shared/ipc.js";
import { type ControllerContext } from "./context.js";

type Command<T extends HarnessCommand["type"]> = Extract<
  HarnessCommand,
  { type: T }
>;

/** 実行中のセッションやほかの worktree 操作と重ならないときだけ、ルートを確保して処理する */
async function withWorktree(
  ctx: ControllerContext,
  sessionId: string,
  run: (
    root: string,
    session: NonNullable<ReturnType<ControllerContext["sessions"]["get"]>>,
  ) => Promise<CommandResult>,
  extraBusy?: (root: string) => boolean,
): Promise<CommandResult> {
  const session = ctx.sessions.get(sessionId);
  const root = session ? ctx.workspaceRoot(session) : undefined;
  if (
    !session?.worktree ||
    !root ||
    ctx.sessionBusy.has(sessionId) ||
    ctx.runtime(session.id).status !== "idle" ||
    ctx.worktreeBusy.has(root)
  )
    return { ok: false, error: "Worktree unavailable or busy" };
  if (extraBusy?.(root)) return { ok: false, error: "Workspace writer busy" };
  ctx.worktreeBusy.add(root);
  ctx.sessionBusy.add(sessionId);
  try {
    return await run(root, session);
  } finally {
    ctx.worktreeBusy.delete(root);
    ctx.sessionBusy.delete(sessionId);
  }
}

export function restoreWorktree(
  ctx: ControllerContext,
  command: Command<"restore_worktree">,
): Promise<CommandResult> {
  return withWorktree(ctx, command.sessionId, async (root, session) => {
    await ctx.repository.restore(
      root,
      session.worktree!,
      command.confirmed,
      new AbortController().signal,
    );
    ctx.runtime(session.id).tools = undefined;
    await ctx.emitState();
    return { ok: true };
  });
}

export function finishWorktree(
  ctx: ControllerContext,
  command: Command<"finish_worktree">,
): Promise<CommandResult> {
  const session = ctx.sessions.get(command.sessionId);
  // マージは、同じワークスペースで worktree を使わない書き込みセッションが動いていない時だけ
  const writerBusy = () =>
    command.action === "merge" &&
    ctx.sessions
      .list()
      .some(
        (s) =>
          s.workspaceId === session?.workspaceId &&
          !s.worktree &&
          !s.readOnly &&
          (ctx.sessionBusy.has(s.id) ||
            (ctx.existingRuntime(s.id)?.status ?? "idle") !== "idle"),
      );
  return withWorktree(
    ctx,
    command.sessionId,
    async (root, current) => {
      await ctx.repository.finish(
        root,
        current.worktree!,
        command.action,
        !!command.confirmed,
        new AbortController().signal,
      );
      if (command.action === "remove" || command.action === "remove_branch") {
        await ctx.sessions.save({ ...current, worktree: undefined, cwd: root });
        ctx.runtime(current.id).tools = undefined;
      }
      await ctx.emitState();
      return { ok: true };
    },
    writerBusy,
  );
}

/** clone(または既存なら fetch)してワークスペースに加える。同時に1件まで */
export class RepositoryOpener {
  private abortController?: AbortController;
  constructor(private readonly ctx: ControllerContext) {}

  abort() {
    this.abortController?.abort();
  }

  async open(command: Command<"open_repository">): Promise<CommandResult> {
    const { ctx } = this;
    if (ctx.options.fake)
      return {
        ok: false,
        error: "Repository network operations are disabled in fake mode",
      };
    if (this.abortController)
      return { ok: false, error: "Repository operation busy" };
    this.abortController = new AbortController();
    let result;
    try {
      result = await ctx.repository.open(
        command,
        this.abortController.signal,
        (message) => ctx.options.emit({ type: "repository_progress", message }),
      );
    } finally {
      this.abortController = undefined;
    }
    const workspaceId = await ctx.workspaces.add(
      result.root,
      Date.now(),
      result.remoteUrl,
    );
    await ctx.emitState();
    return { ok: true, workspaceId };
  }
}
