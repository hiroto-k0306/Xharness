import { memoryHash } from "./memory-sources.js";
import {
  improvementText,
  validCases,
  validSource,
  parseImprovementAction,
  type Improvement,
} from "../../shared/improvements.js";
export interface ImprovementDocument {
  version: 1;
  entries: Improvement[];
}
export class ImprovementFault extends Error {}
const identifier = (v: unknown) =>
  typeof v === "string" && /^[\w-]{1,128}$/.test(v);
export const validImprovementDocument = (
  v: unknown,
): v is ImprovementDocument => {
  const d = v as ImprovementDocument;
  return (
    !!d &&
    d.version === 1 &&
    Array.isArray(d.entries) &&
    d.entries.length <= 20 &&
    new Set(d.entries.map((e) => e?.id)).size === d.entries.length &&
    d.entries.every(
      (e) =>
        identifier(e?.id) &&
        /^[a-f0-9]{64}$/.test(e.scope) &&
        improvementText(e.name) &&
        Number.isSafeInteger(e.revision) &&
        e.revision >= 1 &&
        validCases(e.cases) &&
        validSource(e.source) &&
        Array.isArray(e.versions) &&
        e.versions.length >= 1 &&
        e.versions.length <= 10 &&
        new Set(e.versions.map((v) => v?.id)).size === e.versions.length &&
        e.versions.every(
          (v, index) =>
            identifier(v?.id) &&
            improvementText(v.name) &&
            improvementText(v.body, 8000) &&
            v.hash === memoryHash(v.body) &&
            Number.isFinite(v.createdAt) &&
            (!v.parent ||
              e.versions.slice(0, index).some((p) => p.id === v.parent)),
        ) &&
        (!e.adopted || e.versions.some((v) => v.id === e.adopted)) &&
        Array.isArray(e.results) &&
        e.results.length <= 60 &&
        new Set(e.results.map((r) => `${r.sessionId}/${r.taskId}`)).size ===
          e.results.length &&
        e.results.every(
          (r) =>
            !!parseImprovementAction({
              ...r,
              action: "record",
              id: e.id,
              revision: e.revision,
            }) &&
            /^[a-f0-9]{64}$/.test(r.traceHash) &&
            e.versions.some((v) => v.id === r.versionId) &&
            e.cases.some((c) => c.id === r.caseId),
        ) &&
        Array.isArray(e.history) &&
        e.history.length <= 40 &&
        e.history.every(
          (h, index) =>
            Number.isFinite(h.at) &&
            improvementText(h.reason, 1000) &&
            e.versions.some((v) => v.id === h.to) &&
            h.from === e.history[index - 1]?.to,
        ) &&
        e.adopted === e.history.at(-1)?.to,
    )
  );
};
