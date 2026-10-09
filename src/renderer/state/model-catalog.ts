/**
 * The catalog models the main process sent with the app state (catalog/models.yaml).
 * The UI reads provider and effort support from here instead of model names.
 */
export interface UiCatalogModel {
  id: string;
  alias?: string;
  provider: string;
  efforts?: string[];
}
let models: UiCatalogModel[] = [];

export function uiCatalogModel(model: string) {
  const parts = model.split(":");
  const name = parts.length === 2 ? parts[1] : model;
  const provider = parts.length === 2 ? parts[0] : undefined;
  return models.find(
    (entry) =>
      (!provider || entry.provider === provider) &&
      (entry.id === name || entry.alias === name),
  );
}

export function uiModelLabel(model: string) {
  const entry = uiCatalogModel(model);
  return entry?.alias && model.split(":").at(-1) === entry.alias
    ? `${entry.provider}:${entry.alias} → ${entry.id}`
    : model;
}

export function setUiModelCatalog(list: UiCatalogModel[] | undefined) {
  models = list ?? [];
}

/** Catalog provider; IDs outside the catalog keep the former name rule. */
export function uiProviderOf(model: string): "claude" | "codex" {
  const listed = uiCatalogModel(model)?.provider;
  if (listed === "claude" || listed === "codex") return listed;
  return /^(gpt|o\d|codex)/i.test(model) ? "codex" : "claude";
}

/** Whether effort applies (and is shown). Unknown models keep showing it. */
export function uiSendsEffort(model: string): boolean {
  if (model === "fake") return false;
  const listed = uiCatalogModel(model);
  return listed ? (listed.efforts?.length ?? 0) > 0 : true;
}
