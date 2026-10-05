import { withSessionTrace, traceOperation } from "../core/trace.js";
import { projectSkillTools } from "../tools/project-skills.js";
import { loadProjectConfig } from "../config/project.js";
import { type ControllerContext, type Runtime } from "./context.js";
import { type PermissionGate } from "./permission-gate.js";
import { type StoredSession } from "./store.js";
import {
  type SkillUiRequest,
  type SkillListing,
  type SkillPreview,
} from "../../shared/project-skills.js";
import { type CommandResult } from "../../shared/ipc.js";

/** UI reads use the real tool validator, gate, boundaries and trace; never a renderer filesystem API. */
export async function readSkillUi(
  ctx: ControllerContext,
  gate: PermissionGate,
  session: StoredSession,
  rt: Runtime,
  request: Exclude<SkillUiRequest, { action: "cancel" }>,
  signal: AbortSignal,
): Promise<CommandResult> {
  const name =
    request.action === "list" ? "ListProjectSkills" : "LoadProjectSkill";
  const input =
    request.action === "preview"
      ? { source: request.source, hash: request.hash }
      : {};
  const tool = projectSkillTools({
    home: ctx.options.home,
    sessions: ctx.sessions,
    workspaces: ctx.workspaces,
    sessionId: session.id,
    workspaceId: session.workspaceId,
    cwd: session.cwd,
    clean: ctx.clean,
  }).get(name)!;
  const root = ctx.workspaceRoot(session);
  rt.config = await loadProjectConfig(ctx.options.home, root, {
    trusted: !root || !!rt.trustedSession || (await ctx.trust.isTrusted(root)),
  });
  return withSessionTrace(ctx.options.home, session.id, ctx.clean, async () => {
    const output = await traceOperation(
      "tool",
      name,
      { ...input, uiAction: request.action },
      async () => {
        if (await tool.validate(input))
          return { isError: true, content: "invalid_selection" };
        if (!(await gate.ask({ session, rt, call: { name, input }, signal })))
          return {
            isError: true,
            content: signal.aborted ? "cancelled" : "permission_denied",
          };
        signal.throwIfAborted();
        return tool.execute(input, signal);
      },
    );
    if (signal.aborted) return { ok: false, error: "取消しました。" };
    if (output.isError)
      return {
        ok: false,
        error:
          output.content === "permission_denied"
            ? "スキル読取が拒否されました。"
            : "スキルが更新・削除・不正、または読取不可です。一覧を再取得してください。",
      };
    return {
      ok: true,
      skills: JSON.parse(output.content) as SkillListing | SkillPreview,
    };
  });
}
