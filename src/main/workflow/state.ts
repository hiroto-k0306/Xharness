export type Phase =
  | "off"
  | "classify"
  | "plan"
  | "implement"
  | "review"
  | "complete"
  | "attention";
export interface ReviewFinding {
  severity: "must" | "should" | "nit";
  file: string;
  line?: number;
  message: string;
}
export function findings(text: string): ReviewFinding[] {
  const value: unknown = JSON.parse(
    text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""),
  );
  if (
    !Array.isArray(value) ||
    value.some((f: unknown) => {
      if (!f || typeof f !== "object") return true;
      const v = f as ReviewFinding;
      return (
        !["must", "should", "nit"].includes(v.severity) ||
        typeof v.file !== "string" ||
        !v.file ||
        typeof v.message !== "string" ||
        !v.message ||
        (v.line !== undefined && (!Number.isSafeInteger(v.line) || v.line < 1))
      );
    })
  )
    throw new Error("Reviewer must return a JSON array of ReviewFinding");
  return value as ReviewFinding[];
}
export class WorkflowState {
  phase: Phase;
  reviewRound = 0;
  findings: ReviewFinding[] = [];
  constructor(
    mode: "auto" | "always" | "off",
    private readonly reviewRounds = 2,
  ) {
    this.phase =
      mode === "auto" ? "classify" : mode === "always" ? "plan" : "off";
  }
  approve() {
    if (!["plan", "classify", "implement"].includes(this.phase))
      throw new Error("Plan cannot be approved in this phase");
    this.phase = "implement";
  }
  requestReview(integrated: boolean, changed: boolean) {
    if (this.phase !== "implement" || !integrated || !changed)
      throw new Error("Review requires integrated items and actual changes");
    this.phase = "review";
  }
  reviewed(result: ReviewFinding[]) {
    if (this.phase !== "review") throw new Error("Not reviewing");
    this.findings = structuredClone(result);
    this.reviewRound++;
    this.phase = !result.some(
      (f) => f.severity === "must" || f.severity === "should",
    )
      ? "complete"
      : this.reviewRound >= this.reviewRounds
        ? "attention"
        : "implement";
  }
}
