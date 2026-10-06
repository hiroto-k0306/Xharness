import { isEffort } from "./config.js";
import { loadCatalog, type CatalogModel } from "./catalog.js";
import { type ReasoningEffort } from "../providers/provider.js";

export type { CatalogModel } from "./catalog.js";

/** Models from the shipped catalog (see catalog.ts for roles and capabilities). */
export function loadModelCatalog(): CatalogModel[] {
  return loadCatalog().models;
}

export function catalogEffort(model: CatalogModel, effort?: ReasoningEffort) {
  const selected = effort ?? model.defaultEffort;
  const wire = selected && model.efforts?.[selected];
  if (!selected || !isEffort(selected) || !isEffort(wire))
    throw new Error("Unsupported catalog effort");
  return wire;
}
