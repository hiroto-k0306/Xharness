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
    scope: source === "responses" ? "responses-request" : "main-loop",
    observedAt: new Date().toISOString(),
    raw: measurement.raw,
    input: totals.input,
    output: totals.output,
  };
}

/** SDK modelUsage is cumulative query-pipeline usage; main-loop usage is only a fallback. */
export function measureSdkResult(event: Record<string, unknown>) {
  const models = event.modelUsage;
  if (models && typeof models === "object" && Object.keys(models).length) {
    const iterations = Object.values(models).map((value) => {
      const m =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      return {
        input_tokens: m.inputTokens,
        output_tokens: m.outputTokens,
        cache_read_input_tokens: m.cacheReadInputTokens,
        cache_creation_input_tokens: m.cacheCreationInputTokens,
      };
    });
    const result = measure("sdk-result", { iterations });
    return result ? { ...result, scope: "query-pipeline" as const } : null;
  }
  const usage = event.usage as Record<string, unknown> | undefined;
  if (
    (event.subtype !== "success" || event.is_error === true) &&
    usage?.input_tokens === 0 &&
    usage?.output_tokens === 0
  )
    return null;
  return measure("sdk-result", usage);
}
