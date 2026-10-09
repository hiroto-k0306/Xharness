import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { parse } from "yaml";
import { type ProviderId } from "../core/types.js";
import { type ReasoningEffort } from "../providers/provider.js";

const EFFORT_NAMES: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const isEffortName = (v: unknown): v is ReasoningEffort =>
  typeof v === "string" && (EFFORT_NAMES as readonly string[]).includes(v);

/** Capabilities are declared in the catalog, never inferred from model names. */
export interface CatalogCapabilities {
  serverCompaction?: boolean;
  quotaWindow?: string;
}
export interface CatalogModel {
  imageInput?: boolean;
  provider: ProviderId;
  id: string;
  alias?: string;
  displayName?: string;
  enabled: boolean;
  contextTokens: number | null;
  efforts?: Partial<Record<ReasoningEffort, string>>;
  defaultEffort?: ReasoningEffort;
  retiresAt?: string;
  acceptedIds?: string[];
  /** Explicit previous generations of this alias. Policy migration only, never record ID lookup. */
  historicalIds?: string[];
  capabilities?: CatalogCapabilities;
}
export type RoleName =
  | "main"
  | "fallback"
  | "explorer"
  | "reviewer"
  | "utility"
  | "question"
  | "compaction"
  | "authRefresh"
  | "connectionTest";
type RoleEntry = string | { model: string; effort?: ReasoningEffort | null };
export interface CatalogVersion {
  version: number;
  updatedAt: string;
  /** sha256 of the catalog text, so an edited catalog is distinguishable. */
  digest: string;
}
export interface Catalog extends CatalogVersion {
  models: CatalogModel[];
  roles: Record<string, RoleEntry | Record<string, RoleEntry>>;
  retired: { id: string; at: string }[];
}
/** A role resolved to one concrete model. */
export interface ResolvedModel {
  /** The catalog key as written, e.g. `claude:haiku`. */
  key: string;
  provider: ProviderId;
  /** The ID sent to the provider. */
  id: string;
  /** Effort for this role; undefined means the caller does not send one. */
  effort?: ReasoningEffort;
  model: CatalogModel;
}

export function parseCatalog(text: string): Catalog {
  const doc = parse(text) as Record<string, unknown> | null;
  if (!doc || !Array.isArray(doc.models))
    throw new Error("Model catalog unavailable");
  const updatedAt = doc.updatedAt;
  return {
    version: typeof doc.version === "number" ? doc.version : 0,
    updatedAt:
      updatedAt instanceof Date
        ? updatedAt.toISOString().slice(0, 10)
        : String(updatedAt ?? ""),
    digest: createHash("sha256").update(text).digest("hex"),
    models: doc.models as CatalogModel[],
    roles:
      doc.roles && typeof doc.roles === "object"
        ? (doc.roles as Catalog["roles"])
        : {},
    retired: Array.isArray(doc.retired)
      ? (doc.retired as { id: unknown; at: unknown }[]).map((r) => ({
          id: String(r.id),
          at: String(
            r.at instanceof Date ? r.at.toISOString().slice(0, 10) : r.at,
          ),
        }))
      : [],
  };
}

let override: Catalog | undefined;
/** Tests only: replace the catalog every resolver sees; undefined restores the shipped one. */
export function overrideCatalogForTest(catalog: Catalog | undefined) {
  override = catalog;
}
/** Source / packaged main both resolve the repository-shipped catalog, never cwd. */
export function loadCatalog(): Catalog {
  if (override) return override;
  // The small shipped file is reread at every boundary; a corrupt update must
  // stop the next call rather than silently reusing an earlier parsed catalog.
  // Keep Node filesystem URLs out of Vite's renderer asset URL rewriting.
  const FileURL = URL;
  for (const path of [
    new FileURL("../../../catalog/models.yaml", import.meta.url),
    new FileURL("../../catalog/models.yaml", import.meta.url),
  ]) {
    try {
      return parseCatalog(readFileSync(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      /* Only a missing layout may try the bundled location. */
    }
  }
  throw new Error("Model catalog unavailable");
}

/** `alias → id` for executable catalog models; historical IDs remain readable. */
export function catalogAliases(catalog: Catalog = loadCatalog()) {
  const entries = catalog.models
    .filter(
      (m) =>
        typeof m.alias === "string" &&
        m.alias &&
        !catalogUnavailableReason(m.id, catalog),
    )
    .map((m) => [m.alias!, m.id] as const);
  if (new Set(entries.map(([alias]) => alias)).size !== entries.length)
    throw new Error("モデルカタログのalias対応が競合しています。");
  return Object.fromEntries(entries);
}

/** The catalog entry for an ID (including accepted alternate IDs). */
export function catalogModel(
  id: string,
  catalog: Catalog = loadCatalog(),
): CatalogModel | undefined {
  return catalog.models.find(
    (m) => m.id === id || (m.acceptedIds ?? []).includes(id),
  );
}

/** Retired by the dated `retired` list or by its own `retiresAt`. */
export function isRetired(
  id: string,
  catalog: Catalog = loadCatalog(),
  now = Date.now(),
) {
  const model = catalogModel(id, catalog);
  const dates = [
    ...catalog.retired.filter((r) => r.id === id).map((r) => r.at),
    ...(model?.retiresAt ? [String(model.retiresAt)] : []),
  ];
  return dates.some((d) => {
    const t = Date.parse(d);
    return Number.isFinite(t) && t <= now;
  });
}

/**
 * Why a model cannot be used, or undefined when it can. Never proposes a
 * substitute: callers stop with this reason.
 */
export function catalogUnavailableReason(
  id: string,
  catalog: Catalog = loadCatalog(),
  now = Date.now(),
): string | undefined {
  const model = catalogModel(id, catalog);
  if (!model) return `モデル「${id}」はモデルカタログにありません。`;
  if (!model.enabled) return `モデル「${id}」はモデルカタログで無効です。`;
  if (isRetired(model.id, catalog, now))
    return `モデル「${id}」は提供終了（モデルカタログ）です。`;
  return undefined;
}

/** `provider:alias`, alias or ID → catalog model. Undefined when not in the catalog. */
export function catalogLookup(
  spec: string,
  catalog: Catalog = loadCatalog(),
): CatalogModel | undefined {
  const colon = spec.indexOf(":");
  const provider = colon > 0 ? spec.slice(0, colon) : undefined;
  const name = colon > 0 ? spec.slice(colon + 1) : spec;
  const matches = catalog.models.filter(
    (m) =>
      (!provider || m.provider === provider) &&
      (m.alias === name ||
        m.id === name ||
        (m.acceptedIds ?? []).includes(name)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Saved selection stays generation-free; a call resolves a separate concrete ID. */
export interface ModelPolicy {
  provider: ProviderId;
  model: string;
  effort?: ReasoningEffort;
}

export function normalizeModelPolicy(
  spec: string,
  effort?: string,
  catalog: Catalog = loadCatalog(),
  aliases?: Record<string, string>,
): ModelPolicy {
  const text = spec.trim();
  const colon = text.indexOf(":");
  const provider = colon > 0 ? text.slice(0, colon) : undefined;
  let name = colon > 0 ? text.slice(colon + 1) : text;
  if (!name || (provider && provider !== "claude" && provider !== "codex"))
    throw new Error(`モデル選択「${spec}」のprovider/aliasが不正です。`);
  const direct = catalog.models.filter(
    (m) => m.alias === name && (!provider || m.provider === provider),
  );
  if (direct.length && aliases && Object.hasOwn(aliases, name)) {
    const target = aliases[name];
    if (
      !direct.some(
        (m) =>
          m.id === target ||
          m.alias === target ||
          `${m.provider}:${m.alias}` === target,
      )
    )
      throw new Error(
        `モデルalias「${name}」が設定とカタログで競合しています。`,
      );
  }
  if (!direct.length && aliases && Object.hasOwn(aliases, name))
    name = aliases[name]!;
  const targetColon = name.indexOf(":");
  const targetProvider =
    targetColon > 0 ? name.slice(0, targetColon) : provider;
  if (provider && targetProvider && provider !== targetProvider)
    throw new Error(`モデル選択「${spec}」のproviderが競合しています。`);
  if (targetColon > 0) name = name.slice(targetColon + 1);
  const matches = catalog.models.filter(
    (m) =>
      !!m.alias &&
      (!targetProvider || m.provider === targetProvider) &&
      (m.alias === name ||
        m.id === name ||
        (m.acceptedIds ?? []).includes(name) ||
        (m.historicalIds ?? []).includes(name)),
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? `モデルalias「${spec}」の対応が競合しています。`
        : `モデル「${spec}」に明示されたalias対応がありません。`,
    );
  if (effort !== undefined && !isEffortName(effort))
    throw new Error(`モデル選択のeffort「${effort}」が不正です。`);
  const target = matches[0]!;
  return {
    provider: target.provider,
    model: target.alias!,
    ...(effort !== undefined ? { effort: effort as ReasoningEffort } : {}),
  };
}

/** Resolve immediately before use; never fall back or alter a saved concrete record ID. */
export function resolveModelPolicy(
  spec: string,
  effort?: string,
  catalog: Catalog = loadCatalog(),
  aliases?: Record<string, string>,
): ModelPolicy & { id: string; catalog: CatalogVersion } {
  const policy = normalizeModelPolicy(spec, effort, catalog, aliases);
  const target = catalog.models.find(
    (m) => m.provider === policy.provider && m.alias === policy.model,
  )!;
  const reason = catalogUnavailableReason(target.id, catalog);
  if (reason) throw new Error(`${reason}別のモデルへは切り替えていません。`);
  if (
    policy.effort &&
    (!target.efforts?.[policy.effort] ||
      !isEffortName(target.efforts[policy.effort]))
  )
    throw new Error(
      `モデルalias「${policy.model}」のeffort「${policy.effort}」は対応していません。`,
    );
  return { ...policy, id: target.id, catalog: catalogVersion(catalog) };
}

/** Whether effort is sent for this model: only models that list efforts. */
export function sendsEffort(model: CatalogModel) {
  return !!model.efforts && Object.keys(model.efforts).length > 0;
}

/**
 * Resolves a role (optionally a per-provider or named sub-role, e.g.
 * `reviewer` + `ofClaude`, `question` + `codex`). Throws a reason when the
 * role is missing or points at a disabled, retired or unknown model.
 */
export function resolveRole(
  role: RoleName,
  sub?: string,
  catalog: Catalog = loadCatalog(),
  now = Date.now(),
): ResolvedModel {
  const raw = catalog.roles[role];
  const entry =
    sub === undefined
      ? raw
      : raw && typeof raw === "object" && !("model" in raw)
        ? (raw as Record<string, RoleEntry>)[sub]
        : undefined;
  if (!entry)
    throw new Error(
      `モデルカタログに役割「${role}${sub ? `.${sub}` : ""}」がありません。`,
    );
  const spec =
    typeof entry === "string" ? entry : (entry as { model?: unknown }).model;
  if (typeof spec !== "string")
    throw new Error(
      `モデルカタログの役割「${role}${sub ? `.${sub}` : ""}」の指定が不正です。`,
    );
  const model = catalogLookup(spec, catalog);
  if (!model)
    throw new Error(
      `役割「${role}${sub ? `.${sub}` : ""}」のモデル「${spec}」はモデルカタログにありません。`,
    );
  const reason = catalogUnavailableReason(model.id, catalog, now);
  if (reason)
    throw new Error(
      `役割「${role}${sub ? `.${sub}` : ""}」を使えません：${reason}別のモデルへは切り替えていません。`,
    );
  const explicit =
    typeof entry === "object" && "effort" in entry ? entry.effort : undefined;
  if (explicit !== undefined && explicit !== null && !isEffortName(explicit))
    throw new Error(`役割「${role}」のeffortが不正です。`);
  if (explicit && (!model.efforts || !model.efforts[explicit]))
    throw new Error(
      `役割「${role}${sub ? `.${sub}` : ""}」のeffort「${explicit}」はモデル「${model.id}」が対応していません。`,
    );
  return {
    key: spec,
    provider: model.provider,
    id: model.id,
    ...(explicit ? { effort: explicit } : {}),
    model,
  };
}

/** The effort to use: the role's, else the model's default when it sends effort. */
export function roleEffort(
  resolved: ResolvedModel,
): ReasoningEffort | undefined {
  return (
    resolved.effort ??
    (sendsEffort(resolved.model) ? resolved.model.defaultEffort : undefined)
  );
}

export function catalogVersion(
  catalog: Catalog = loadCatalog(),
): CatalogVersion {
  return {
    version: catalog.version,
    updatedAt: catalog.updatedAt,
    digest: catalog.digest,
  };
}

/**
 * Startup arguments for the connection-test profile: the role's model key and
 * its effort (the role's, else the model's default; none for a model without efforts).
 */
export function connectionTestStartup(catalog: Catalog = loadCatalog()) {
  const role = resolveRole("connectionTest", undefined, catalog);
  return { model: role.key, effort: roleEffort(role) };
}
