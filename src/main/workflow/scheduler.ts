import { type CatalogModel } from "../config/model-catalog.js";
import { type PlanItem, validatePlan } from "./plan-validate.js";

export type PlanItemStatus = "pending" | "running" | "integrated" | "failed";

/** Phase 5 starts with one active assignment, including its worktree integration. */
export class SerialScheduler {
  private readonly items: PlanItem[];
  private readonly statuses = new Map<string, PlanItemStatus>();

  constructor(
    items: PlanItem[],
    catalog: readonly CatalogModel[],
    options: Parameters<typeof validatePlan>[2] = {},
  ) {
    const result = validatePlan(items, catalog, options);
    if (result.errors.length) throw new Error(result.errors.join("\n"));
    this.items = structuredClone(items);
    for (const item of this.items) this.statuses.set(item.id, "pending");
  }

  /** Main assignments are returned unchanged; the caller must not spawn a worker. */
  startNext(): PlanItem | undefined {
    if (
      [...this.statuses.values()].some((s) => s === "running" || s === "failed")
    )
      return undefined;
    const ready = this.items.find(
      (item) =>
        this.statuses.get(item.id) === "pending" &&
        item.dependsOn.every((id) => this.statuses.get(id) === "integrated"),
    );
    if (!ready) return undefined;
    this.statuses.set(ready.id, "running");
    return structuredClone(ready);
  }

  /** Call only after worker output has been merged and the wave checks passed. */
  integrated(id: string): void {
    this.finish(id, "integrated");
  }

  /** Integration conflicts and failed tests pause dispatch until main handles them. */
  fail(id: string): void {
    this.finish(id, "failed");
  }

  retry(id: string): void {
    if (this.statuses.get(id) !== "failed")
      throw new Error("項目は失敗状態ではありません");
    this.statuses.set(id, "pending");
  }

  snapshot(): { id: string; status: PlanItemStatus }[] {
    return [...this.statuses].map(([id, status]) => ({ id, status }));
  }

  resolveFailure(id: string): void {
    if (
      this.statuses.get(id) !== "failed" ||
      [...this.statuses.values()].some((s) => s === "running")
    )
      throw new Error("項目の失敗を解決できません");
    this.statuses.set(id, "integrated");
  }

  private finish(id: string, status: "integrated" | "failed"): void {
    if (this.statuses.get(id) !== "running")
      throw new Error("項目は実行状態ではありません");
    this.statuses.set(id, status);
  }
}
