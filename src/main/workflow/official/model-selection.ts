import { z } from "zod";
import { redact } from "../../core/redact.js";
import {
  normalizeModelPolicy,
  type ModelPolicy,
  type CatalogVersion,
} from "../../config/catalog.js";
import {
  WorkflowFailure,
  effort as effortContract,
  type AgentRequest,
  type ModelCandidate,
} from "./contracts.js";
import type { WorkflowOptions, WorkflowRecord } from "./runtime.js";

export interface ModelSelectionEvidence {
  policy: ModelPolicy;
  resolved: {
    provider: ModelCandidate["provider"];
    model: string;
    effort: AgentRequest["effort"];
    catalog: CatalogVersion;
  };
  previous?: {
    model: string;
    effort: AgentRequest["effort"];
    catalog?: CatalogVersion;
  };
  changed: boolean;
}
export interface WorkflowModelPolicies {
  planner?: ModelPolicy;
  question?: ModelPolicy;
  tasks?: Record<string, { assignee: ModelPolicy; reviewer?: ModelPolicy }>;
}
export type ResolveCallModel = (
  policy: ModelPolicy,
  signal: AbortSignal,
) => Promise<{ model: ModelCandidate; catalog: CatalogVersion }>;

const policyContract = z
  .object({
    provider: z.enum(["claude", "codex"]),
    model: z.string().min(1).max(128),
    effort: effortContract.optional(),
  })
  .strict();
const catalogContract = z
  .object({
    version: z.number().int().positive(),
    updatedAt: z.string().min(1).max(100),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const modelEvidenceContract = z
  .object({
    policy: policyContract,
    resolved: z
      .object({
        provider: z.enum(["claude", "codex"]),
        model: z.string().min(1).max(128),
        effort: effortContract.nullable(),
        catalog: catalogContract,
      })
      .strict(),
    previous: z
      .object({
        model: z.string().min(1).max(128),
        effort: effortContract.nullable(),
        catalog: catalogContract.optional(),
      })
      .strict()
      .optional(),
    changed: z.boolean(),
  })
  .strict();
/** Shape checks use saved facts only; unknown historical IDs remain readable. */
export function validateSavedModelSelections(record: WorkflowRecord) {
  if (record.modelPolicies !== undefined)
    z.object({
      planner: policyContract.optional(),
      question: policyContract.optional(),
      tasks: z
        .record(
          z.string(),
          z
            .object({
              assignee: policyContract,
              reviewer: policyContract.optional(),
            })
            .strict(),
        )
        .optional(),
    })
      .strict()
      .parse(record.modelPolicies);
  for (const call of record.calls)
    if (call.modelSelection !== undefined)
      modelEvidenceContract.parse(call.modelSelection);
}
function assertPolicyScope(
  policy: ModelPolicy,
  provider: ModelCandidate["provider"],
  original: string,
  effort: AgentRequest["effort"],
) {
  if (policy.provider !== provider)
    throw new WorkflowFailure("model-policy-provider-changed");
  if ((policy.effort ?? null) !== effort)
    throw new WorkflowFailure("model-policy-effort-changed");
  const expected = selectionPolicy(provider, original, effort);
  if (expected.model !== policy.model)
    throw new WorkflowFailure("model-policy-family-changed");
}
function selectionFailure(error: unknown): WorkflowFailure {
  const message = error instanceof Error ? error.message : "";
  return new WorkflowFailure(
    /^(モデル選択|モデルalias|モデル「|必要な公式モデル|このモデル|モデルは|無効なモデル)/.test(
      message,
    )
      ? redact(message).slice(0, 1000)
      : "モデルのalias/利用枠/effortを解決できません。別のモデルへは切り替えていません。",
  );
}
async function checkedResolve(
  resolver: ResolveCallModel,
  policy: ModelPolicy,
  signal: AbortSignal,
) {
  try {
    return await resolver(policy, signal);
  } catch (error) {
    signal.throwIfAborted();
    throw selectionFailure(error);
  }
}
/** Historical selections are normalized only through explicit catalog mappings. */
export function selectionPolicy(
  provider: ModelCandidate["provider"],
  model: string,
  effort: AgentRequest["effort"],
): ModelPolicy {
  let policy: ModelPolicy;
  try {
    policy = normalizeModelPolicy(
      model.includes(":") ? model : `${provider}:${model}`,
      effort ?? undefined,
    );
  } catch (error) {
    throw selectionFailure(error);
  }
  if (policy.provider !== provider)
    throw new WorkflowFailure("model-policy-provider-changed");
  return policy;
}
function storedPolicy(
  record: WorkflowRecord,
  provider: ModelCandidate["provider"],
  model: string,
  effort: AgentRequest["effort"],
): ModelPolicy | undefined {
  if (
    record.planner?.provider === provider &&
    record.planner.model === model &&
    record.planner.effort === effort
  )
    return (
      record.modelPolicies?.planner ??
      (record.planner.selectedAs
        ? selectionPolicy(provider, record.planner.selectedAs, effort)
        : undefined)
    );
  for (const task of record.plan?.tasks ?? []) {
    const saved = record.modelPolicies?.tasks?.[task.id];
    if (
      task.assignee.provider === provider &&
      task.assignee.model === model &&
      task.assignee.effort === effort
    )
      return saved?.assignee;
    if (
      task.reviewer?.provider === provider &&
      task.reviewer.model === model &&
      task.reviewer.effort === effort
    )
      return saved?.reviewer;
  }
  return undefined;
}
export async function policyCandidate(
  options: WorkflowOptions,
  record: WorkflowRecord,
  provider: ModelCandidate["provider"],
  model: string,
  effort: AgentRequest["effort"],
  signal: AbortSignal,
): Promise<ModelCandidate | undefined> {
  if (options.resolveCallModel) {
    const policy =
      storedPolicy(record, provider, model, effort) ??
      selectionPolicy(provider, model, effort);
    assertPolicyScope(policy, provider, model, effort);
    const resolved = await checkedResolve(
      options.resolveCallModel,
      policy,
      signal,
    );
    if (
      resolved.model.provider !== provider ||
      !resolved.model.available ||
      resolved.model.quotaAllowed !== true ||
      !resolved.model.efforts.includes(policy.effort ?? null)
    )
      return undefined;
    return { ...resolved.model, model };
  }
  return options.models.find(
    (m) =>
      m.provider === provider &&
      m.model === model &&
      m.available &&
      m.quotaAllowed === true &&
      m.efforts.includes(effort),
  );
}
/** Validate current availability without replacing any saved assignment. */
export async function planAvailability(
  options: WorkflowOptions,
  record: WorkflowRecord,
  plan: import("./contracts.js").OfficialPlan,
  signal: AbortSignal,
) {
  if (!options.resolveCallModel) return undefined;
  const usable = new Set<string>();
  const key = (p: string, m: string, e: AgentRequest["effort"]) =>
    JSON.stringify([p, m, e]);
  for (const task of plan.tasks) {
    for (const selection of [task.assignee, task.reviewer]) {
      if (
        selection &&
        (await policyCandidate(
          options,
          record,
          selection.provider,
          selection.model,
          selection.effort,
          signal,
        ))
      )
        usable.add(key(selection.provider, selection.model, selection.effort));
    }
  }
  return (
    p: ModelCandidate["provider"],
    m: string,
    e: AgentRequest["effort"],
  ) => usable.has(key(p, m, e));
}
const role = (phase: AgentRequest["phase"]) =>
  phase === "plan"
    ? "planner"
    : phase === "conversation"
      ? "question"
      : phase === "review"
        ? "reviewer"
        : "assignee";
export function recordTaskPolicies(
  record: WorkflowRecord,
  options: WorkflowOptions,
) {
  if (!options.resolveCallModel || !record.plan) return;
  const tasks: NonNullable<WorkflowModelPolicies["tasks"]> = Object.assign(
    Object.create(null) as NonNullable<WorkflowModelPolicies["tasks"]>,
    record.modelPolicies?.tasks,
  );
  for (const task of record.plan.tasks) {
    const reviewer =
      task.reviewer ??
      options.reviewers[
        task.assignee.provider === "claude" ? "codex" : "claude"
      ];
    tasks[task.id] ??= {
      assignee: selectionPolicy(
        task.assignee.provider,
        task.assignee.model,
        task.assignee.effort,
      ),
      ...(reviewer
        ? {
            reviewer: selectionPolicy(
              task.assignee.provider === "claude" ? "codex" : "claude",
              reviewer.model,
              reviewer.effort,
            ),
          }
        : {}),
    };
  }
  record.modelPolicies = { ...record.modelPolicies, tasks };
}
export async function resolveCallSelection(
  options: Pick<WorkflowOptions, "resolveCallModel">,
  record: WorkflowRecord,
  phase: AgentRequest["phase"],
  original: ModelCandidate,
  effort: AgentRequest["effort"],
  signal: AbortSignal,
): Promise<{
  model: ModelCandidate;
  effort: AgentRequest["effort"];
  modelSelection?: ModelSelectionEvidence;
}> {
  if (!options.resolveCallModel) return { model: original, effort };
  const selectedRole = role(phase);
  const task = record.plan?.tasks[0];
  const saved =
    selectedRole === "planner" || selectedRole === "question"
      ? record.modelPolicies?.[selectedRole]
      : task && record.modelPolicies?.tasks?.[task.id]?.[selectedRole];
  const policy =
    saved ??
    storedPolicy(record, original.provider, original.model, effort) ??
    selectionPolicy(original.provider, original.model, effort);
  assertPolicyScope(policy, original.provider, original.model, effort);
  if (selectedRole === "planner" || selectedRole === "question")
    record.modelPolicies = { ...record.modelPolicies, [selectedRole]: policy };
  const resolved = await checkedResolve(
    options.resolveCallModel,
    policy,
    signal,
  );
  signal.throwIfAborted();
  const chosenEffort = policy.effort ?? null;
  if (
    resolved.model.provider !== policy.provider ||
    !resolved.model.available ||
    resolved.model.quotaAllowed !== true ||
    !resolved.model.efforts.includes(chosenEffort)
  )
    throw new WorkflowFailure("unavailable-model");
  const last = record.calls.findLast(
    (call) =>
      role(call.phase) === selectedRole && call.provider === policy.provider,
  );
  const previous = last
    ? {
        model: last.requestedModel,
        effort: last.effort,
        ...(last.modelSelection
          ? { catalog: last.modelSelection.resolved.catalog }
          : {}),
      }
    : undefined;
  const modelSelection: ModelSelectionEvidence = {
    policy: structuredClone(policy),
    resolved: {
      provider: resolved.model.provider,
      model: resolved.model.model,
      effort: chosenEffort,
      catalog: structuredClone(resolved.catalog),
    },
    ...(previous ? { previous } : {}),
    changed:
      !!previous &&
      (previous.model !== resolved.model.model ||
        previous.effort !== chosenEffort ||
        (!!previous.catalog &&
          previous.catalog.digest !== resolved.catalog.digest)),
  };
  return { model: resolved.model, effort: chosenEffort, modelSelection };
}
