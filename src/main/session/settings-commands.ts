import { withSessionTrace } from "../core/trace.js";
// 設定に関するコマンド: 権限モード、既定モデル(config.yaml の main)、/compact。
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { loadModelCatalog } from "../config/model-catalog.js";
import { prepareProviderHistory } from "../context/provider-compactor.js";
import { Router } from "../core/router.js";
import { systemPrompt } from "./turn.js";
import {
  type CommandResult,
  type Effort,
  type HarnessCommand,
} from "../../shared/ipc.js";
import { checkpointFile, pad, type ControllerContext } from "./context.js";

/** セッションの権限モードを切り替え、その事実をレシートに残す(§9.1) */
export async function setMode(
  ctx: ControllerContext,
  command: Extract<HarnessCommand, { type: "set_mode" }>,
): Promise<CommandResult> {
  const session = ctx.sessions.get(command.sessionId);
  if (!session || (session.readOnly && command.mode !== "plan"))
    return { ok: false, error: "Mode unavailable" };
  await ctx.sessions.save({ ...session, permissionMode: command.mode });
  const rt = await ctx.load(session.id);
  await ctx.record(rt, {
    id: pad(++rt.receiptSeq),
    sessionId: session.id,
    ts: Date.now(),
    provider: "harness",
    kind: "permission",
    durationMs: 0,
    summary: `Mode: ${command.mode}`,
  });
  await ctx.emitState();
  return { ok: true };
}

/** `~/.xharness/config.yaml` の main.model / main.effort を書き換える。適用した effort を返す */
export async function saveDefaultModel(
  home: string,
  command: Extract<HarnessCommand, { type: "set_default_model" }>,
): Promise<{ ok: true; effort: Effort } | { ok: false; error: string }> {
  const model = loadModelCatalog().find(
    (m) => m.enabled && m.id === command.model,
  );
  if (
    !model ||
    (command.effort && model.efforts && !model.efforts[command.effort])
  )
    return { ok: false, error: "Unavailable model or effort" };
  const path = join(home, "config.yaml");
  let doc: Record<string, unknown> = {};
  try {
    doc = parse(await readFile(path, "utf8")) ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    throw new Error("Invalid configuration");
  const effort = command.effort ?? model.defaultEffort ?? "high";
  doc.main = { model: command.model, effort };
  const temp = path + "." + randomUUID() + ".tmp";
  await mkdir(home, { recursive: true });
  await writeFile(temp, stringify(doc));
  await rename(temp, path);
  return { ok: true, effort };
}

/** /compact: 古い履歴を要約に置き換える(元の履歴は保存したまま) */
export async function compactNow(
  ctx: ControllerContext,
  sessionId: string,
): Promise<CommandResult> {
  const rt = await ctx.load(sessionId);
  if (rt.status !== "idle") return { ok: false, error: "Turn already running" };
  const file = checkpointFile(ctx.options.home, sessionId);
  rt.checkpoint ??= await file.read(undefined);
  const session = ctx.sessions.get(sessionId);
  if (!session) return { ok: false, error: "Unknown session" };
  const provider = new Router(
    ctx.options.providers ?? [ctx.options.provider],
  ).provider(session.model);
  const abort = new AbortController();
  let finish: () => void = () => {};
  rt.done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  rt.abort = abort;
  rt.status = "running";
  ctx.options.emit({ type: "turn", sessionId, status: "running" });
  try {
    const result = await withSessionTrace(
      ctx.options.home,
      sessionId,
      ctx.clean,
      async () =>
        prepareProviderHistory(rt.messages, {
          provider,
          model: session.model,
          signal: abort.signal,
          system:
            rt.system ??
            (await systemPrompt(
              ctx,
              session.cwd,
              !session.workspaceId,
              rt.config,
            )),
          tools: [...(rt.tools?.values() ?? [])].map((t) => t.spec),
          checkpoint: rt.checkpoint,
          threshold: 0.8,
          force: true,
        }),
    );
    if (result.checkpoint) {
      rt.checkpoint = result.checkpoint;
      await file.write(result.checkpoint);
    }
    if (result.compacted)
      await ctx.record(rt, {
        id: pad(++rt.receiptSeq),
        sessionId,
        ts: Date.now(),
        provider: "harness",
        kind: "compact",
        durationMs: 0,
        summary: "Manual compact",
      });
    ctx.options.emit({
      type: "notice",
      tone: "dim",
      sessionId,
      message: result.compacted
        ? "古い履歴を圧縮しました（元の履歴は保存済み）"
        : "圧縮できる古い履歴がありません",
    });
    return { ok: true };
  } catch {
    return { ok: false, error: "圧縮に失敗しました。元の履歴を維持しています" };
  } finally {
    rt.status = "idle";
    rt.abort = undefined;
    ctx.options.emit({ type: "turn", sessionId, status: "idle" });
    if (rt.closing) ctx.dropRuntime(sessionId);
    finish();
  }
}
