/**
 * The catalog models the main process sent with the app state (catalog/models.yaml).
 * The UI reads provider and effort support from here instead of model names.
 */
export interface UiCatalogModel {
  id: string;
  provider: string;
  efforts?: string[];
}
let models: UiCatalogModel[] = [];

export function setUiModelCatalog(list: UiCatalogModel[] | undefined) {
  models = list ?? [];
}

/** Catalog provider; IDs outside the catalog keep the former name rule. */
export function uiProviderOf(model: string): "claude" | "codex" {
  const listed = models.find((m) => m.id === model)?.provider;
  if (listed === "claude" || listed === "codex") return listed;
  return /^(gpt|o\d|codex)/i.test(model) ? "codex" : "claude";
}

/** Whether effort applies (and is shown). Unknown models keep showing it. */
export function uiSendsEffort(model: string): boolean {
  if (model === "fake") return false;
  const listed = models.find((m) => m.id === model);
  return listed ? (listed.efforts?.length ?? 0) > 0 : true;
}
