export interface CatalogModel {
  slug: string;
  context_window?: number;
  supported_reasoning_levels?: { effort: string; description?: string }[];
  [key: string]: unknown;
}

export function readCatalog(value: unknown): CatalogModel[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("models" in value) ||
    !Array.isArray(value.models)
  )
    throw new Error("Invalid catalog response");
  if (
    value.models.some(
      (model: unknown) =>
        !model ||
        typeof model !== "object" ||
        !("slug" in model) ||
        typeof model.slug !== "string",
    )
  )
    throw new Error("Invalid model entry");
  return value.models as CatalogModel[];
}
