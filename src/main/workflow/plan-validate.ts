import { isEffort, resolveModel, DEFAULT_ALIASES } from "../config/config.js";
import { type CatalogModel } from "../config/model-catalog.js";
import { type ProviderId } from "../core/types.js";
import { type ReasoningEffort } from "../providers/provider.js";

export interface PlanItem {
  id: string;
  title: string;
  instructions: string;
  files: string[];
  dependsOn: string[];
  assignee: {
    agent: "main" | "worker";
    model: string;
    effort: ReasoningEffort;
    reason: string;
  };
  acceptance: string;
}

export interface PlanValidation {
  errors: string[];
  warnings: string[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(nonempty);

/** Windows-relative paths only. Globs describe files, never escape the workspace. */
function safePath(path: string): boolean {
  return (
    !/^[\\/]|[:\x00-\x1f]/.test(path) &&
    !path
      .replaceAll("\\", "/")
      .split("/")
      .some((p) => p === "..")
  );
}

/** Conservative overlap: uncertain glob intersections require serial dependencies. */
function overlaps(a: string, b: string): boolean {
  const normalize = (path: string) => path.replaceAll("\\", "/").toLowerCase();
  const left = normalize(a);
  const right = normalize(b);
  const prefix = (path: string) => path.split(/[*?\[\]{]/, 1)[0] ?? "";
  if (left === prefix(left) && right === prefix(right)) return left === right;
  return (
    prefix(left).startsWith(prefix(right)) ||
    prefix(right).startsWith(prefix(left))
  );
}

/** Validate untrusted SubmitPlan arguments before approval or scheduling (§21.3). */
export function validatePlan(
  input: unknown,
  catalog: readonly CatalogModel[],
  options: {
    aliases?: Record<string, string>;
    fiveHourUsedPercent?: Partial<Record<ProviderId, number>>;
  } = {},
): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(input) || !input.length)
    return { errors: ["計画には1件以上の項目が必要です"], warnings };
  const items: PlanItem[] = [];
  for (const candidate of input) {
    if (
      !record(candidate) ||
      ![
        candidate.id,
        candidate.title,
        candidate.instructions,
        candidate.acceptance,
      ].every(nonempty) ||
      !strings(candidate.files) ||
      !strings(candidate.dependsOn) ||
      !record(candidate.assignee) ||
      (candidate.assignee.agent !== "main" &&
        candidate.assignee.agent !== "worker") ||
      !nonempty(candidate.assignee.model) ||
      !nonempty(candidate.assignee.reason) ||
      !isEffort(candidate.assignee.effort)
    ) {
      errors.push(
        "計画項目には id/title/instructions/acceptance/files/dependsOn と、assignee: {agent: main|worker, model, effort, reason} が必要です。assignee は文字列ではなくオブジェクトです",
      );
      continue;
    }
    items.push(candidate as unknown as PlanItem);
  }
  if (errors.length) return { errors, warnings };
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== items.length) errors.push("計画の ID が重複しています");
  for (const item of items) {
    if (item.files.some((file) => !safePath(file)))
      errors.push(
        `${item.id}: files はワークスペース内の相対パスにしてください`,
      );
    if (item.dependsOn.some((id) => !ids.has(id)))
      errors.push(`${item.id}: 存在しない依存先があります`);
    const choice = resolveModel(
      item.assignee.model,
      options.aliases ?? DEFAULT_ALIASES,
    );
    const model =
      choice &&
      catalog.find(
        (m) =>
          m.provider === choice.provider && m.id === choice.model && m.enabled,
      );
    if (!model)
      errors.push(`${item.id}: 有効なカタログのモデルを指定してください`);
    // Haiku has no effort parameter: assignment effort is metadata, never sent.
    else if (model.efforts && !model.efforts[item.assignee.effort])
      errors.push(`${item.id}: モデルが effort に対応していません`);
    if (model && (options.fiveHourUsedPercent?.[model.provider] ?? 0) > 90)
      warnings.push(
        `${item.id}: ${model.provider} の5時間枠が90%を超えています。別のプロバイダを検討してください`,
      );
  }
  if (errors.length) return { errors, warnings };
  const byId = new Map(items.map((item) => [item.id, item]));
  const ancestors = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  function visit(id: string): Set<string> {
    if (visiting.has(id)) throw new Error("cycle");
    const cached = ancestors.get(id);
    if (cached) return cached;
    visiting.add(id);
    const all = new Set<string>();
    for (const dep of byId.get(id)!.dependsOn) {
      all.add(dep);
      for (const ancestor of visit(dep)) all.add(ancestor);
    }
    visiting.delete(id);
    ancestors.set(id, all);
    return all;
  }
  try {
    for (const item of items) visit(item.id);
  } catch {
    return { errors: ["計画の依存関係が循環しています"], warnings };
  }
  for (let i = 0; i < items.length; i++) {
    for (const right of items.slice(i + 1)) {
      const left = items[i]!;
      if (
        ancestors.get(left.id)!.has(right.id) ||
        ancestors.get(right.id)!.has(left.id)
      )
        continue;
      if (left.files.some((a) => right.files.some((b) => overlaps(a, b))))
        errors.push(
          `${left.id} / ${right.id}: files が重なるため依存関係で直列にしてください`,
        );
    }
  }
  return { errors, warnings };
}
