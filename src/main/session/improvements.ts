import { improvementRow, loadImprovementTask } from "./improvement-results.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { JsonFile } from "./store.js";
import { readImprovementFile } from "./improvement-file.js";
import { memoryHash, memoryScope } from "./memory-sources.js";
import { ProjectMemory } from "./project-memory.js";
import { ProjectSkills } from "../tools/project-skills.js";
import { historyText, type HistoryScope } from "../tools/project-history.js";
import {
  improvementPrompt,
  type Improvement,
  type ImprovementAction,
  type ImprovementView,
} from "../../shared/improvements.js";

import {
  validImprovementDocument as valid,
  ImprovementFault,
  type ImprovementDocument as Document,
} from "./improvement-document.js";
export { ImprovementFault } from "./improvement-document.js";

/** Small bounded ledger. Uses the existing home writer lock, project identity and atomic JsonFile. */
export class Improvements {
  private static transactions = new Map<string, Promise<unknown>>();
  private access;
  private authorized = new Set<string>();
  constructor(
    private scope: HistoryScope,
    private authorize: (source: {
      source: string;
      hash: string;
    }) => Promise<void> = async () => {},
    private signal?: AbortSignal,
  ) {
    this.access = memoryScope(scope);
  }
  private safe(text: string) {
    return historyText(text, this.scope.clean);
  }
  private async document() {
    const pin = await this.access.identity(),
      path = join(pin.home, "improvements.json");
    const original = await readImprovementFile(path),
      file = new JsonFile<Document>(path, valid);
    let data: Document = { version: 1, entries: [] };
    if (original !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(original);
      } catch {
        /* quarantine below */
      }
      if (valid(parsed)) {
        data = parsed;
        const texts = data.entries.flatMap((e) => [
          e.name,
          ...e.versions.flatMap((v) => [v.name, v.body]),
          ...e.cases.flatMap((c) => [
            c.prompt,
            c.criteria,
            c.taskType,
            c.difficulty,
            c.environment,
          ]),
          ...e.results.map((r) => r.evidence),
          ...e.history.map((h) => h.reason),
        ]);
        if (texts.some((text) => this.safe(text) !== text))
          throw new ImprovementFault(
            "改善記録に秘密フィルター対象があります。出典と保存内容を確認してください。",
          );
      } else {
        await file.read(data); // Reuse existing corrupt-file quarantine; never partially adopt.
        throw new ImprovementFault(
          "改善記録が破損していたため退避しました。確認して再取得してください。",
        );
      }
    }
    if (file.warnings.length)
      throw new ImprovementFault(
        "改善記録が破損していたため退避しました。確認して再取得してください。",
      );
    return { pin, path, original, file, data };
  }
  private async checkSource(e: Improvement) {
    this.signal?.throwIfAborted();
    if (e.source.skill) {
      const key = `${e.source.skill.source}/${e.source.skill.hash}`;
      if (!this.authorized.has(key)) {
        await this.authorize(e.source.skill);
        this.authorized.add(key);
      }
      await new ProjectSkills(this.scope).load(
        e.source.skill.source,
        e.source.skill.hash,
        this.signal,
      );
    }
    if (e.source.memory) {
      const m = (await new ProjectMemory(this.scope).list()).entries.find(
        (m) => m.id === e.source.memory!.id,
      );
      if (
        !m ||
        m.revision !== e.source.memory.revision ||
        m.status !== "accepted" ||
        m.sourceUnavailable ||
        m.expired
      )
        throw new ImprovementFault(
          "出典メモリが変更・無効・一覧範囲外です。新しい比較を作成してください。",
        );
    }
    this.signal?.throwIfAborted();
  }
  private async view(data: Document, scope: string): Promise<ImprovementView> {
    const entries = data.entries.filter((e) => e.scope === scope);
    const rows = [];
    for (const e of entries)
      for (const r of e.results)
        rows.push(await improvementRow(this.scope, e, r));
    if ((await this.access.identity()).key !== scope)
      throw new ImprovementFault("Project changed");
    return { entries, rows, limit: 20 };
  }
  async list() {
    const { data, pin } = await this.document();
    return this.view(data, pin.key);
  }
  async action(a: Exclude<ImprovementAction, { action: "list" | "cancel" }>) {
    const pin = await this.access.identity(),
      key = pin.home.toLowerCase();
    const previous = Improvements.transactions.get(key) ?? Promise.resolve();
    const job = previous
      .catch(() => {})
      .then(async () => {
        this.authorized.clear();
        const d = await this.document();
        if (d.pin.key !== pin.key)
          throw new ImprovementFault("Project changed");
        this.signal?.throwIfAborted();
        let e: Improvement;
        if (a.action === "create") {
          if (d.data.entries.length >= 20)
            throw new ImprovementFault("改善比較はhome全体20件までです。");
          const body = this.safe(a.body);
          if (
            d.data.entries.some(
              (e) => e.scope === pin.key && e.name === this.safe(a.name),
            )
          )
            throw new ImprovementFault(
              "同名の比較は登録済みです。再取得してください。",
            );
          e = {
            id: randomUUID(),
            scope: pin.key,
            name: this.safe(a.name),
            revision: 1,
            source: a.source,
            cases: a.cases.map((c) => ({
              ...c,
              prompt: this.safe(c.prompt),
              criteria: this.safe(c.criteria),
              taskType: this.safe(c.taskType),
              difficulty: this.safe(c.difficulty),
              environment: this.safe(c.environment),
            })),
            versions: [
              {
                id: randomUUID(),
                name: "baseline",
                body,
                hash: memoryHash(body),
                createdAt: Date.now(),
              },
            ],
            results: [],
            history: [],
          };
          await this.checkSource(e);
          d.data.entries.push(e);
        } else {
          const found = d.data.entries.find(
            (e) => e.id === a.id && e.scope === pin.key,
          );
          if (!found || found.revision !== a.revision)
            throw new ImprovementFault(
              "記録が更新されています。再取得して確認してください。",
            );
          e = found;
          if (a.action === "candidate") {
            if (
              e.versions.length >= 10 ||
              !e.versions.some((v) => v.id === a.parent)
            )
              throw new ImprovementFault("候補版上限・親版不正");
            const body = this.safe(a.body);
            if (e.versions.some((v) => v.name === this.safe(a.name)))
              throw new ImprovementFault(
                "同名の候補版は登録済みです。別の版名を指定してください。",
              );
            if (e.versions.some((v) => v.hash === memoryHash(body)))
              throw new ImprovementFault("同じ本文の版は登録済みです。");
            e.versions.push({
              id: randomUUID(),
              parent: a.parent,
              name: this.safe(a.name),
              body,
              hash: memoryHash(body),
              createdAt: Date.now(),
            });
          } else {
            const version = e.versions.find((v) => v.id === a.versionId);
            if (!version) throw new ImprovementFault("Version unavailable");
            if (a.action === "prepare") {
              await this.checkSource(e);
              const c = e.cases.find((c) => c.id === a.caseId);
              if (!c) throw new ImprovementFault("Case unavailable");
              return {
                improvements: await this.view(d.data, pin.key),
                preparedPrompt: improvementPrompt(e, version, c),
              };
            }
            if (a.action === "record") {
              if (
                e.results.length >= 60 ||
                e.results.some(
                  (r) => r.versionId === a.versionId && r.caseId === a.caseId,
                )
              )
                throw new ImprovementFault(
                  "この版・課題の評価は登録済みです。再測定は新しい比較で行ってください。",
                );
              const sessionId =
                a.sessionId === "current" ? this.scope.sessionId : a.sessionId;
              const taskId =
                a.taskId === "current"
                  ? (await this.scope.sessions.evaluationTask(sessionId))?.id
                  : a.taskId;
              if (!taskId)
                throw new ImprovementFault("保存済みタスクがありません。");
              const record = {
                versionId: a.versionId,
                caseId: a.caseId,
                sessionId,
                taskId,
                passed: a.passed,
                evidence: this.safe(a.evidence),
              };
              const { traceHash } = await loadImprovementTask(
                this.scope,
                e,
                record,
              );
              e.results.push({ ...record, traceHash });
            } else {
              if (e.adopted === a.versionId || e.history.length >= 40)
                throw new ImprovementFault("既に採用済み・切替履歴上限");
              if (
                a.action === "restore" &&
                !e.history.some((h) => h.to === a.versionId)
              )
                throw new ImprovementFault("以前採用した版だけ復帰できます。");
              await this.checkSource(e);
              for (const c of e.cases) {
                const r = e.results.find(
                  (r) => r.versionId === a.versionId && r.caseId === c.id,
                );
                if (!r || !(await improvementRow(this.scope, e, r)).quality)
                  throw new ImprovementFault(
                    "全固定課題の完了と有効な明示評価の合格が必要です。模擬は本番品質を保証しません。",
                  );
              }
              e.history.push({
                from: e.adopted,
                to: a.versionId,
                at: Date.now(),
                reason: this.safe(a.reason),
              });
              e.adopted = a.versionId;
            }
          }
          e.revision++;
        }
        this.signal?.throwIfAborted();
        if (a.action === "adopt" || a.action === "restore")
          await this.checkSource(e);
        if ((await this.access.identity()).key !== pin.key)
          throw new ImprovementFault("Project changed");
        const current = await readImprovementFile(d.path);
        if (current !== d.original)
          throw new ImprovementFault(
            "改善ファイルが外部変更されています。再取得してください。",
          );
        if (
          !valid(d.data) ||
          Buffer.byteLength(JSON.stringify(d.data, null, 2)) > 1048576
        )
          throw new ImprovementFault("Improvement schema/byte limit");
        await d.file.write(d.data);
        return { improvements: await this.view(d.data, pin.key) };
      });
    Improvements.transactions.set(key, job);
    try {
      return await job;
    } finally {
      if (Improvements.transactions.get(key) === job)
        Improvements.transactions.delete(key);
    }
  }
}
