import {
  type Improvement,
  type ImprovementView,
} from "../../shared/improvements.js";
import {
  type ModelCandidate,
  type ModelCandidateView,
  type CandidateSample,
} from "../../shared/model-candidates.js";
import { type HistoryScope } from "../tools/project-history.js";
import { loadImprovementTask } from "./improvement-results.js";
import { memoryHash } from "./memory-sources.js";
import { type CandidateQuotas } from "./candidate-quota.js";
import { type Effort } from "../../shared/ipc.js";
export interface CandidateModel {
  id: string;
  provider: string;
  efforts: Effort[];
}
/** No score mixes providers, cache regimes, quota percentages, tokens or money. */
export async function modelCandidates(
  scope: HistoryScope,
  view: ImprovementView,
  selection: {
    id: string;
    revision: number;
    versionId: string;
    caseId: string;
  },
  models: CandidateModel[],
  quotas: CandidateQuotas,
  now: number,
): Promise<ModelCandidateView> {
  const e = view.entries.find(
    (e) => e.id === selection.id && e.revision === selection.revision,
  )!;
  const c = e.cases.find((c) => c.id === selection.caseId)!,
    v = e.versions.find((v) => v.id === selection.versionId)!;
  const candidates: ModelCandidate[] = models.flatMap((m) =>
    (m.efforts.length ? m.efforts : [undefined]).map((effort) => ({
      id: `${m.provider}/${m.id}/${effort ?? "none"}`,
      provider: m.provider,
      model: m.id,
      effort,
      priority: false,
      selectable: true,
      quota: quotas.view(m.provider, now),
      samples: [],
      reasons: [],
    })),
  );
  const omitted: string[] = [];
  for (const r of e.results.filter(
    (r) => r.versionId === v.id && r.caseId === c.id,
  )) {
    const row = view.rows.find(
      (row) =>
        row.taskId === r.taskId &&
        row.sessionId === r.sessionId &&
        row.versionId === r.versionId,
    );
    if (!row?.valid) {
      omitted.push(`${r.sessionId}/${r.taskId}: 記録変更・削除・未確定`);
      continue;
    }
    try {
      const { task, traceHash, measuredAt } = await loadImprovementTask(
        scope,
        e,
        r,
      );
      if (traceHash !== r.traceHash) {
        omitted.push(`${r.sessionId}/${r.taskId}: trace変更`);
        continue;
      }
      const configurations = new Set(
        task.calls.map(
          (call) => `${call.provider}/${call.model}/${call.effort ?? "none"}`,
        ),
      );
      const candidate =
        configurations.size === 1
          ? candidates.find((x) => x.id === [...configurations][0])
          : undefined;
      if (!candidate) {
        omitted.push(
          `${r.sessionId}/${r.taskId}: 混在構成・不明effort・未対応モデル`,
        );
        continue;
      }
      const eligible =
        row.quality &&
        row.resourceComparable &&
        row.elapsedMs !== null &&
        !task.recordingIncomplete &&
        task.simulatedCalls === 0 &&
        task.calls.length > 0;
      const cacheKnown = task.calls.every(
        (call) =>
          call.measurement &&
          call.tokens.cacheRead !== null &&
          (call.provider !== "claude" || call.tokens.cacheWrite !== null),
      );
      const sample: CandidateSample = {
        sessionId: r.sessionId,
        taskId: r.taskId,
        evidence: r.evidence,
        input: row.input,
        output: row.output,
        elapsedMs: row.elapsedMs,
        measuredAt: measuredAt ?? null,
        coverage: `In ${row.inputCoverage}, Out ${row.outputCoverage}`,
        cache: cacheKnown
          ? JSON.stringify(
              task.calls.map((call) => [
                call.tokens.cacheRead,
                call.provider === "claude"
                  ? call.tokens.cacheWrite
                  : "別建て未提供",
              ]),
            )
          : "不明",
        eligible,
        reason: eligible
          ? "同一固定入力・有効な明示品質評価・全In/Out取得の実測"
          : `${row.quality ? "品質充足" : "品質未充足"} / ${row.note}`,
      };
      candidate.samples.push(sample);
    } catch {
      omitted.push(`${r.sessionId}/${r.taskId}: 根拠再照合失敗`);
    }
  }
  for (const x of candidates) {
    x.selectable = x.quota.state !== "exhausted";
    x.priority =
      x.selectable &&
      omitted.length === 0 &&
      x.samples.at(-1)?.eligible === true;
    if (omitted.length)
      x.reasons.push(
        "この版・課題に構成または有効性を再照合できない登録があります。最新構成を確定できないため優先提示・数量の優劣は保留します。",
      );
    x.reasons.push(
      `登録観測 ${x.samples.length}件 / 優先根拠を満たす ${x.samples.filter((s) => s.eligible).length}件。最新登録の品質・模擬・欠測も確認し、合格した記録だけを抽出して選択しません。`,
    );
    x.reasons.push(
      x.priority
        ? "優先検討: 同条件で品質を満たす実測あり（将来の成功・最適性は未保証）"
        : "優先根拠不足: 有効な同条件実測なし、または共有枠枯渇で見送り",
    );
    if (!x.samples.length)
      x.reasons.push("未測定。品質・使用量をゼロとしません。");
    if (x.quota.state !== "observed")
      x.reasons.push(
        `枠 ${x.quota.state}: 利用可能性の保証なし。模擬・古い観測を残量として使いません。`,
      );
    const latest = x.samples.at(-1)?.eligible ? x.samples.at(-1) : undefined;
    if (latest && latest.cache !== "不明" && omitted.length === 0) {
      const dominated = candidates
        .filter((y) => y.provider === x.provider && y.id !== x.id)
        .some((y) => {
          const other =
            y.selectable && y.samples.at(-1)?.eligible
              ? y.samples.at(-1)
              : undefined;
          return (
            other &&
            other.cache === latest.cache &&
            other.input! <= latest.input! &&
            other.output! <= latest.output! &&
            other.elapsedMs! <= latest.elapsedMs! &&
            (other.input! < latest.input! ||
              other.output! < latest.output! ||
              other.elapsedMs! < latest.elapsedMs!)
          );
        });
      x.reasons.push(
        dominated
          ? "最新の有効観測は、同provider・同cache内訳の別候補がIn/Out/時間の全項目で同等以下。少数観測の参考であり統計的優越ではありません。"
          : "最新観測の全項目で上回る同provider・同cache候補なし。同率・トレードオフ・比較不能を含み、唯一の最適ではありません。",
      );
    } else x.reasons.push("cache内訳欠測・実測不足: 数量の優劣は比較不能。");
  }
  candidates.sort(
    (a, b) =>
      Number(b.priority) - Number(a.priority) || a.id.localeCompare(b.id),
  );
  const current = scope.sessions.get(scope.sessionId);
  return {
    snapshot: memoryHash({
      selection: {
        id: selection.id,
        revision: selection.revision,
        versionId: selection.versionId,
        caseId: selection.caseId,
      },
      e: identity(e),
      candidates,
      omitted,
      model: current?.model,
      effort: current?.effort,
    }),
    observedAt: now,
    expiresAt: now + 60_000,
    conditions: `${e.name}/${v.name}/${c.id} / ${c.taskType} / ${c.difficulty} / ${c.criteria} / ${c.environment} / 本文hash ${v.hash} / 初期状態は利用者申告`,
    candidates,
    omitted,
    allExhausted:
      candidates.length > 0 && candidates.every((x) => !x.selectable),
  };
}
const identity = (e: Improvement) => ({
  revision: e.revision,
  source: e.source,
  cases: e.cases,
  versions: e.versions,
  results: e.results,
});
