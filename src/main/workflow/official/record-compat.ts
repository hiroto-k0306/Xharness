import type { AgentRequest, ModelCandidate } from "./contracts.js";
import type { PlannerChoice, WorkflowRecord } from "./runtime.js";

type Fixed = {
  provider: ModelCandidate["provider"];
  model: string;
  effort: AgentRequest["effort"];
};
/**
 * Models implied by official workflow records that did not record them, per
 * record format version. Full IDs only, fixed here: never derived from the
 * current catalog aliases, so a later alias generation cannot change history.
 * Version 1 records without `planner` were planned by Opus 5.5 (high); plans
 * without a reviewer were reviewed by Opus 5.5 (high) or GPT-6 Luna (low).
 */
const RECORD_COMPAT: Readonly<
  Record<
    number,
    { planner: Fixed; reviewers: Record<"claude" | "codex", Fixed> }
  >
> = {
  1: {
    planner: { provider: "claude", model: "claude-opus-5-5", effort: "high" },
    reviewers: {
      claude: { provider: "claude", model: "claude-opus-5-5", effort: "high" },
      codex: { provider: "codex", model: "gpt-6-luna", effort: "low" },
    },
  },
};

/** What a resumed record needs that it did not record itself. */
export interface ImpliedModels {
  planner?: PlannerChoice;
  reviewers: Partial<
    Record<
      "claude" | "codex",
      { model: string; effort: AgentRequest["effort"] }
    >
  >;
}
/**
 * Resolves only what this record lacks. Throws a reason when the record's
 * format version has no fixed definition: history is never guessed.
 */
export function impliedRecordModels(record: WorkflowRecord): ImpliedModels {
  // A record that already has its plan never needs a planner again.
  const needsPlanner = !record.planner && !record.plan;
  const needsReviewer = (record.plan?.tasks ?? []).some((t) => !t.reviewer);
  if (!needsPlanner && !needsReviewer) return { reviewers: {} };
  const compat = RECORD_COMPAT[record.version];
  if (!compat)
    throw new Error(
      `再開できません：記録形式v${String(record.version)}の記録に必要なモデルを確定できません。推測では置き換えません。`,
    );
  return {
    ...(needsPlanner ? { planner: { ...compat.planner } } : {}),
    reviewers: needsReviewer
      ? {
          claude: {
            model: compat.reviewers.claude.model,
            effort: compat.reviewers.claude.effort,
          },
          codex: {
            model: compat.reviewers.codex.model,
            effort: compat.reviewers.codex.effort,
          },
        }
      : {},
  };
}
