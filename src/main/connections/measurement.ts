import type { Measurement } from "./contracts.js";
import { normalizeTokens, tokenMeasurement } from "../providers/token-usage.js";

export function measure(
  source: Measurement["source"],
  value: unknown,
): Measurement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const measurement = tokenMeasurement(
    source === "responses" ? "codex" : "claude",
    value,
  );
  const totals = normalizeTokens(measurement);
  return {
    source,
    observedAt: new Date().toISOString(),
    raw: measurement.raw,
    input: totals.input,
    output: totals.output,
  };
}
