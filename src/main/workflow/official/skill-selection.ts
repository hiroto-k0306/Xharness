import { z } from "zod";
import { isAbsolute } from "node:path";
import { redact } from "../../core/redact.js";
import type {
  OfficialSkillBundle,
  OfficialSkillSelection,
  OfficialSkillEvidence,
} from "../../../shared/official-skills.js";
import {
  WorkflowFailure,
  type AgentRequest,
  type OfficialProvider,
} from "./contracts.js";
import type { WorkflowOptions, WorkflowRecord } from "./runtime.js";

export const officialSkillSelectionContract = z
  .object({
    provider: z.enum(["claude", "codex"]),
    scope: z.enum(["user", "project"]),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    source: z.string().min(1).max(4000).refine(isAbsolute),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    bundleHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export function parseSkillSelections(value: unknown): OfficialSkillSelection[] {
  const selections = z
    .array(officialSkillSelectionContract)
    .max(50)
    .parse(value);
  if (
    new Set(selections.map((skill) => `${skill.provider}:${skill.name}`))
      .size !== selections.length
  )
    throw new WorkflowFailure("official-skills-duplicate-name");
  return selections;
}
export function validateSavedSkillSelections(record: WorkflowRecord) {
  if (record.officialSkills !== undefined)
    parseSkillSelections(record.officialSkills);
  for (const call of record.calls)
    if (call.officialSkills !== undefined) {
      z.object({
        requested: z.array(officialSkillSelectionContract).max(50),
        dispatched: z
          .array(
            z
              .object({
                name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
                mechanism: z.enum(["claude-plugin", "codex-skill-input"]),
              })
              .strict(),
          )
          .max(100)
          .optional(),
        observed: z
          .array(
            z
              .object({
                name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
                status: z.enum(["requested", "allowed", "completed", "denied"]),
              })
              .strict(),
          )
          .max(100)
          .optional(),
      })
        .strict()
        .parse(call.officialSkills);
    }
}
export type ResolveOfficialSkills = (
  selections: OfficialSkillSelection[],
  signal: AbortSignal,
) => Promise<OfficialSkillBundle[]>;
/** A saved selection is metadata, never a reference-text substitution or a skill body. */
export function skillSelections(
  bundles: readonly OfficialSkillSelection[],
): OfficialSkillSelection[] {
  return bundles.map(({ provider, scope, name, source, hash, bundleHash }) => ({
    provider,
    scope,
    name,
    source,
    hash,
    bundleHash,
  }));
}
/** Validate all pinned sources before each phase, then expose only that company's selections. */
export async function resolveCallSkills(
  options: Pick<WorkflowOptions, "nativeWork" | "resolveOfficialSkills">,
  record: WorkflowRecord,
  provider: OfficialProvider,
  phase: AgentRequest["phase"],
  signal: AbortSignal,
): Promise<OfficialSkillBundle[]> {
  const selections = record.officialSkills ?? [];
  if (!selections.length) return [];
  if (phase === "conversation")
    throw new WorkflowFailure("official-skills-question-unsupported");
  if (!options.nativeWork)
    throw new WorkflowFailure("official-skills-fixed-task-unsupported");
  if (!options.resolveOfficialSkills)
    throw new WorkflowFailure("official-skills-validation-unavailable");
  signal.throwIfAborted();
  let bundles: OfficialSkillBundle[];
  try {
    bundles = await options.resolveOfficialSkills(
      structuredClone(selections),
      signal,
    );
  } catch (error) {
    signal.throwIfAborted();
    const message = error instanceof Error ? error.message : "";
    throw new WorkflowFailure(
      /^(スキル|選択したスキル|未対応のスキル|登録されたprovider)/.test(message)
        ? redact(message).slice(0, 1000)
        : "official-skills-source-changed-or-unavailable",
    );
  }
  signal.throwIfAborted();
  const actual = skillSelections(bundles);
  if (JSON.stringify(actual) !== JSON.stringify(skillSelections(selections)))
    throw new WorkflowFailure("official-skills-selection-mismatch");
  return bundles.filter((bundle) => bundle.provider === provider);
}

/** Preserve requested facts and project only named, allowlisted provider evidence. */
export function skillEvidence(
  requested: readonly OfficialSkillSelection[],
  actual?: OfficialSkillEvidence,
): OfficialSkillEvidence {
  const names = new Set(requested.map((skill) => skill.name));
  const provider = requested[0]?.provider;
  return {
    requested: skillSelections(requested),
    ...(actual?.dispatched
      ? {
          dispatched: actual.dispatched
            .filter(
              (item) =>
                names.has(item.name) &&
                item.mechanism ===
                  (provider === "claude"
                    ? "claude-plugin"
                    : "codex-skill-input"),
            )
            .slice(0, 100)
            .map(({ name, mechanism }) => ({ name, mechanism })),
        }
      : {}),
    ...(actual?.observed
      ? {
          observed: actual.observed
            .filter(
              (item) =>
                names.has(item.name) &&
                ["requested", "allowed", "completed", "denied"].includes(
                  item.status,
                ),
            )
            .slice(0, 100)
            .map(({ name, status }) => ({ name, status })),
        }
      : {}),
  };
}
