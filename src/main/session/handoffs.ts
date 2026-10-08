import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, readFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonFile } from "./store.js";
import { readTraceReplay } from "./report-trace.js";
import { evaluateTrace } from "./evaluation.js";
import { officialHandoffSource } from "./handoff-official.js";
import {
  historyText,
  projectHistoryAccess,
  type HistoryScope,
} from "../tools/project-history.js";
import {
  type HandoffAction,
  type HandoffRecord,
  type HandoffView,
} from "../../shared/handoffs.js";

const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fail = (message: string): never => {
  throw new HandoffFault(message);
};
export class HandoffFault extends Error {}
const valid = (v: unknown): v is HandoffRecord[] =>
  Array.isArray(v) &&
  v.length <= 100 &&
  Buffer.byteLength(JSON.stringify(v), "utf8") <= 2_000_000 &&
  v.every(
    (r: HandoffRecord) =>
      r &&
      [r.id, r.sourceId, r.destinationId, r.workspaceId, r.taskId].every(
        (s) => typeof s === "string" && /^[\w-]{1,512}$/.test(s),
      ) &&
      [r.sourceCreatedAt, r.destinationCreatedAt].every(
        (s) => typeof s === "number" && Number.isFinite(s),
      ) &&
      [r.completedAt, r.receivedAt].every(
        (s) => typeof s === "string" && Number.isFinite(Date.parse(s)),
      ) &&
      [r.bodyHash, r.sourceHash].every(
        (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s),
      ) &&
      [r.project, r.sourceCwd, r.destinationCwd].every(
        (s) => typeof s === "string" && s.length <= 4096,
      ) &&
      typeof r.body === "string" &&
      r.body.length > 0 &&
      r.body.length <= 16_000 &&
      r.bodyHash === hash(r.body),
  ) &&
  new Set(v.map((r) => r.id)).size === v.length;

/** One atomic record is BOTH send receipt and persistent destination inbox.
 * Never append messages or execute a model. Requires the normal home writer lock.
 */
export class Handoffs {
  private generation = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private previews = new Map<
    string,
    { record: HandoffRecord; expires: number }
  >();
  constructor(
    private readonly home: string,
    private readonly now = Date.now,
  ) {}
  clear() {
    this.generation++;
    this.previews.clear();
  }
  drain() {
    return this.chain;
  }
  private async file(scope: HistoryScope) {
    const pin = await projectHistoryAccess(scope).pin;
    if (!pin || (await realpath(this.home)) !== pin.home)
      fail("project/home境界を確認してください。");
    const path = join(pin!.home, "handoffs.json");
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000)
        fail("受け渡し台帳を確認してください。");
      if ((await realpath(path)) !== path) fail("台帳の別名は使用できません。");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    // Fail closed on corruption: never discard a delivery and resend it.
    const file = new JsonFile<HandoffRecord[]>(path, valid);
    let records: HandoffRecord[] = [];
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!valid(value))
        fail("台帳の形式が不明です。配送状態を確認してください。");
      records = value as HandoffRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        fail("台帳を読めません。配送状態が不明のため送信を停止します。");
    }
    return { file, records, pin: pin! };
  }
  async run(
    scope: HistoryScope,
    action: HandoffAction,
    writable: (ids: string[]) => Promise<void> = async () => {},
  ): Promise<HandoffView> {
    if (action.action === "cancel") {
      const p = this.previews.get(action.previewId);
      if (
        action.previewId === "all" ||
        p?.record.sourceId === scope.sessionId
      ) {
        this.generation++;
        for (const [id, preview] of this.previews)
          if (preview.record.sourceId === scope.sessionId)
            this.previews.delete(id);
      }
      return { records: [] };
    }
    const generation = this.generation;
    const job = this.chain.then(() =>
      this.perform(scope, action, writable, generation),
    );
    this.chain = job.catch(() => undefined);
    return job;
  }
  private async source(scope: HistoryScope, destinationId: string) {
    const access = projectHistoryAccess(scope),
      pin = await access.pin;
    const source = scope.sessions.get(scope.sessionId),
      destination = scope.sessions.get(destinationId);
    if (
      !source ||
      !destination ||
      source.id === destination.id ||
      !(await access.eligible(source, true)) ||
      !(await access.eligible(destination))
    )
      fail("同じprojectの別の保存済み会話を選んでください。");
    const settled = await scope.sessions.evaluationTask(source!.id),
      destinationTask = await scope.sessions.evaluationTask(destination!.id);
    const history = await scope.sessions.historyRecords(source!.id, pin!.home);
    const last = history?.records.at(-1)?.message;
    if (
      !history ||
      history.truncated ||
      !last ||
      last.role !== "assistant" ||
      last.content.some((b) => b.type === "tool_use") ||
      history.records.some((r) => r.message.meta?.rewind)
    )
      fail("最終回答を確認できません。巻き戻し・欠落のある会話は対象外です。");
    let official: Awaited<ReturnType<typeof officialHandoffSource>>;
    try {
      official = await officialHandoffSource(
        scope,
        pin!.home,
        history!.records.map((r) => r.message),
      );
    } catch {
      fail(
        "公式workflowの確定結果と最終回答を確認できません。実行状態・保存記録を確認してください。",
      );
    }
    if (
      settled?.active ||
      (!official && (!settled || settled.settled !== true)) ||
      settled?.recoveryRequired ||
      destinationTask?.recoveryRequired
    )
      fail("確定済みの完了タスクと、保存未確定でない宛先が必要です。");
    let completedAt = official?.completedAt;
    let taskId = official?.taskId;
    let trace: Awaited<ReturnType<typeof readTraceReplay>>;
    if (!official) {
      trace = await readTraceReplay(pin!.home, source!.id, scope.clean);
      const task = evaluateTrace(trace).find((t) => t.taskId === settled!.id);
      if (!task || task.outcome !== "completed" || task.recordingIncomplete)
        fail(
          "最終回答と完了traceを確認できません。巻き戻し・欠落のある会話は対象外です。",
        );
      const roots = new Set(
        trace!.records
          .filter(
            (r) =>
              r.kind === "task" &&
              r.phase === "start" &&
              (r.input as { taskId?: string })?.taskId === task!.taskId,
          )
          .map((r) => r.id),
      );
      const ends = trace!.records.filter(
        (r) => r.kind === "task" && r.phase === "end" && roots.has(r.id),
      );
      completedAt = ends.at(-1)?.at;
      taskId = settled!.id;
      if (!completedAt || !Number.isFinite(Date.parse(completedAt)))
        fail("完了日時が不明です。");
      // Manual compaction after completion is not the original final answer.
      if (
        trace!.records.some(
          (r) =>
            r.kind === "llm" && Date.parse(r.at) > Date.parse(completedAt!),
        )
      )
        fail("完了後に会話が変更されています。元の結果を特定できません。");
    }
    const body = historyText(
      last!.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n"),
      scope.clean,
    );
    if (!body.trim() || body.length > 16_000)
      fail("本文は空でない16,000文字以内の最終回答に限ります。");
    return {
      id: randomUUID(),
      sourceId: source!.id,
      sourceCreatedAt: source!.createdAt,
      destinationId: destination!.id,
      destinationCreatedAt: destination!.createdAt,
      workspaceId: source!.workspaceId!,
      project: pin!.root,
      sourceCwd: source!.cwd,
      destinationCwd: destination!.cwd,
      taskId: taskId!,
      completedAt: completedAt!,
      body,
      bodyHash: hash(body),
      sourceHash: hash({ history, trace, settled, official }),
    } satisfies HandoffRecord;
  }
  private async perform(
    scope: HistoryScope,
    action: Exclude<HandoffAction, { action: "cancel" }>,
    writable: (ids: string[]) => Promise<void>,
    generation: number,
  ): Promise<HandoffView> {
    const { file, records, pin } = await this.file(scope),
      access = projectHistoryAccess(scope);
    const visible = async () => {
      if (!(await access.eligible(scope.sessions.get(scope.sessionId), true)))
        fail("現在のprojectを確認してください。");
      const out: HandoffView["records"] = [];
      for (const r of records) {
        const current = scope.sessions.get(scope.sessionId);
        const dest = scope.sessions.get(r.destinationId);
        if (
          r.project !== pin.root ||
          !dest ||
          dest.createdAt !== r.destinationCreatedAt ||
          dest.workspaceId !== r.workspaceId ||
          dest.cwd !== r.destinationCwd ||
          !(await access.eligible(dest, true))
        )
          continue;
        if (
          (r.sourceId !== scope.sessionId &&
            r.destinationId !== scope.sessionId) ||
          (r.destinationId === scope.sessionId &&
            current?.createdAt !== r.destinationCreatedAt)
        )
          continue;
        const source = scope.sessions.get(r.sourceId);
        out.push({
          ...r,
          sourceAvailable:
            !!source &&
            source.createdAt === r.sourceCreatedAt &&
            (await access.eligible(source, true)),
        });
      }
      return { records: out };
    };
    if (action.action === "list") return visible();
    if (action.action === "preview") {
      await writable([scope.sessionId, action.destinationId]);
      const record = await this.source(scope, action.destinationId);
      if (generation !== this.generation) fail("取消しました。");
      for (const [id, p] of this.previews)
        if (p.expires <= this.now() || p.record.sourceId === scope.sessionId)
          this.previews.delete(id);
      if (this.previews.size >= 100)
        fail("確認票が多すぎます。再取得してください。");
      this.previews.set(record.id, { record, expires: this.now() + 60_000 });
      return { ...(await visible()), preview: record };
    }
    const delivered = records.find(
      (r) => r.id === action.previewId && r.sourceId === scope.sessionId,
    );
    if (delivered) {
      const view = await visible();
      if (!view.records.some((r) => r.id === delivered.id))
        fail("宛先を現在確認できません。台帳は変更せず配送記録を保持します。");
      return view; // Lost reply/double click: do not write twice.
    }
    const p = this.previews.get(action.previewId);
    if (!p || p.record.sourceId !== scope.sessionId || p.expires <= this.now())
      fail("確認票が失効・取消されました。再プレビューしてください。");
    await writable([scope.sessionId, p!.record.destinationId]);
    const latest = await this.source(scope, p!.record.destinationId);
    if (hash({ ...latest, id: p!.record.id }) !== hash(p!.record))
      fail("出典または宛先が変更されました。再プレビューしてください。");
    if (
      !(await access.eligible(scope.sessions.get(scope.sessionId), true)) ||
      !(await access.eligible(scope.sessions.get(latest.destinationId))) ||
      latest.sourceHash !==
        (await this.source(scope, latest.destinationId)).sourceHash
    )
      fail("出典・project・確定状態が変更されました。");
    if (
      this.previews.get(action.previewId) !== p ||
      generation !== this.generation
    )
      fail("取消しました。");
    const duplicate = records.find(
      (r) =>
        r.sourceId === latest.sourceId &&
        r.taskId === latest.taskId &&
        r.bodyHash === latest.bodyHash &&
        r.destinationId === latest.destinationId &&
        r.destinationCreatedAt === latest.destinationCreatedAt,
    );
    if (!duplicate) {
      if (records.length >= 100) fail("受け渡しはhomeごと100件までです。");
      records.push({
        ...p!.record,
        receivedAt: new Date(this.now()).toISOString(),
      });
      if (!valid(records)) fail("台帳の容量上限に達しました。");
      // Commit point. Cancellation after this starts cannot retract a receipt.
      this.previews.delete(action.previewId);
      await file.write(records);
    }
    this.previews.delete(action.previewId);
    return visible();
  }
}
