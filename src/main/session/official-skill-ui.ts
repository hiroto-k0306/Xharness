import type { ControllerContext, Runtime } from "./context.js";
import type { StoredSession } from "./store.js";
import type { PermissionGate } from "./permission-gate.js";
import type { OfficialSkillAction } from "../../shared/official-skills.js";
import type { CommandResult } from "../../shared/ipc.js";
import { projectHistoryAccess } from "../tools/project-history.js";
import { loadProjectConfig } from "../config/project.js";
import { OfficialSkills } from "./official-skills.js";
import { lstat } from "node:fs/promises";

/** Main-owned source identity and the existing permission gate precede every read. */
export async function officialSkillUi(
  ctx: ControllerContext,
  gate: PermissionGate,
  session: StoredSession,
  rt: Runtime,
  request: OfficialSkillAction,
  signal: AbortSignal,
): Promise<CommandResult> {
  const selected = structuredClone(session.officialSkills ?? []);
  if (request.action === "clear") {
    signal.throwIfAborted();
    const latest = ctx.sessions.get(session.id);
    if (!latest) return { ok: false, error: "Session unavailable" };
    await ctx.sessions.save({ ...latest, officialSkills: [] });
    return { ok: true, officialSkills: { selected: [] } };
  }
  const access = projectHistoryAccess({
    home: ctx.options.home,
    sessions: ctx.sessions,
    workspaces: ctx.workspaces,
    sessionId: session.id,
    workspaceId: session.workspaceId,
    cwd: session.cwd,
    clean: ctx.clean,
  });
  const pin = await access.pin;
  if (
    !pin ||
    !(await ctx.sessions.ownsHome(pin.home)) ||
    !(await access.eligible(session, true))
  )
    return {
      ok: false,
      error: "登録したプロジェクト・会話の所有範囲を確認できません。",
    };
  const identities = await Promise.all(
    [pin.root, session.cwd].map(async (path) => {
      const info = await lstat(path);
      return { path, identity: `${info.dev}:${info.ino}` };
    }),
  );
  const verifyScope = async () => {
    signal.throwIfAborted();
    if (!(await access.eligible(ctx.sessions.get(session.id), true)))
      throw new Error("読取中にプロジェクト・会話が変更されました。");
    for (const { path, identity } of identities) {
      const info = await lstat(path);
      if (info.isSymbolicLink() || `${info.dev}:${info.ino}` !== identity)
        throw new Error(
          "読取中にプロジェクト・会話のディレクトリが交換されました。",
        );
    }
  };
  rt.config = await loadProjectConfig(ctx.options.home, pin.root, {
    trusted: !!rt.trustedSession || (await ctx.trust.isTrusted(pin.root)),
  });
  const provider =
    request.action === "select" ? request.selection.provider : request.provider;
  const source =
    request.action === "select"
      ? request.selection.source
      : request.action === "preview"
        ? request.source
        : undefined;
  if (
    !(await gate.ask({
      session,
      rt,
      signal,
      call: {
        name: "ReadOfficialSkills",
        input: {
          provider,
          action: request.action,
          ...(source ? { source } : {}),
        },
      },
    }))
  )
    return { ok: false, error: "公式スキルの読取が拒否されました。" };
  signal.throwIfAborted();
  await verifyScope();
  const skills = new OfficialSkills({ cwd: session.cwd, provider });
  if (request.action === "list") {
    const catalog = await skills.list();
    await verifyScope();
    return { ok: true, officialSkills: { catalog, selected } };
  }
  if (request.action === "preview") {
    const preview = await skills.preview(request.source);
    await verifyScope();
    return { ok: true, officialSkills: { preview, selected } };
  }
  await skills.select(request.selection);
  const next = selected.filter(
    (s) => !(s.provider === provider && s.source === request.selection.source),
  );
  if (
    next.some(
      (s) => s.provider === provider && s.name === request.selection.name,
    )
  )
    return {
      ok: false,
      error: "同じproviderで同名のスキルは同時に選択できません。",
    };
  if (next.length >= 8)
    return { ok: false, error: "公式スキルの選択は8件までです。" };
  next.push(structuredClone(request.selection));
  await verifyScope();
  const latest = ctx.sessions.get(session.id);
  if (!latest) return { ok: false, error: "Session unavailable" };
  await ctx.sessions.save({ ...latest, officialSkills: next });
  return { ok: true, officialSkills: { selected: next } };
}
