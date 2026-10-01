import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { isEffort } from "./config.js";
import { type ProviderId } from "../core/types.js";
import { type ReasoningEffort } from "../providers/provider.js";

export interface CatalogModel {
  provider: ProviderId;
  id: string;
  enabled: boolean;
  contextTokens: number | null;
  efforts?: Partial<Record<ReasoningEffort, string>>;
  defaultEffort?: ReasoningEffort;
}

/** Source / packaged main both resolve the repository-shipped catalog, never cwd. */
export function loadModelCatalog(): CatalogModel[] {
  for (const path of [
    new URL("../../../catalog/models.yaml", import.meta.url),
    new URL("../../catalog/models.yaml", import.meta.url),
  ]) {
    try {
      const doc = parse(readFileSync(path, "utf8")) as {
        models: CatalogModel[];
      };
      if (!Array.isArray(doc.models)) throw new Error();
      return doc.models;
    } catch {
      /* Try the bundled layout next. */
    }
  }
  throw new Error("Model catalog unavailable");
}

export function catalogEffort(model: CatalogModel, effort?: ReasoningEffort) {
  const selected = effort ?? model.defaultEffort;
  const wire = selected && model.efforts?.[selected];
  if (!selected || !isEffort(selected) || !isEffort(wire))
    throw new Error("Unsupported catalog effort");
  return wire;
}
