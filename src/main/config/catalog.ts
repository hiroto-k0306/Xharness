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

let shipped: Catalog | undefined;
let override: Catalog | undefined;
/** Tests only: replace the catalog every resolver sees; undefined restores the shipped one. */
export function overrideCatalogForTest(catalog: Catalog | undefined) {
  override = catalog;
}
/** Source / packaged main both resolve the repository-shipped catalog, never cwd. */
export function loadCatalog(): Catalog {
  if (override) return override;
  if (shipped) return shipped;
  // Keep Node filesystem URLs out of Vite's renderer asset URL rewriting.
  const FileURL = URL;
  for (const path of [
    new FileURL("../../../catalog/models.yaml", import.meta.url),
    new FileURL("../../catalog/models.yaml", import.meta.url),
  ]) {
    try {
      shipped = parseCatalog(readFileSync(path, "utf8"));
      return shipped;
    } catch {
      /* Try the bundled layout next. */
    }
  }
  throw new Error("Model catalog unavailable");
}

/** `alias → id` for executable catalog models; historical IDs remain readable. */
export function catalogAliases(catalog: Catalog = loadCatalog()) {
  return Object.fromEntries(
    catalog.models
      .filter(
        (m) =>
          typeof m.alias === "string" &&
          m.alias &&
          !catalogUnavailableReason(m.id, catalog),
      )
      .map((m) => [m.alias!, m.id]),
  ) as Record<string, string>;
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
  const model =
    catalog.models.find((m) => m.alias === name) ?? catalogModel(name, catalog);
  if (!model || (provider !== undefined && model.provider !== provider))
    return undefined;
  return model;
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
