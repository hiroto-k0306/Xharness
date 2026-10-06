import {
  tokenMeasurement,
  normalizeTokens,
} from "../../providers/token-usage.js";
import type { RuntimeUsage } from "./contracts.js";
export const count = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;
export const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export const modelName = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
export function sdkUsage(event: Record<string, unknown>): RuntimeUsage | null {
  const models = Object.entries(object(event.modelUsage));
  if (models.length) {
    const byModel = models
      .filter(([name]) => modelName(name))
      .map(([model, value]) => {
        const raw = Object.fromEntries(
          Object.entries(object(value)).filter(
            ([k, v]) =>
              [
                "inputTokens",
                "outputTokens",
                "cacheReadInputTokens",
                "cacheCreationInputTokens",
                "thinkingTokens",
              ].includes(k) && count(v),
          ),
        ) as Record<string, number>;
        return { model, raw };
      });
    if (byModel.length !== models.length) return null;
    const measurement = tokenMeasurement("claude", {
      iterations: byModel.map(({ raw }) => ({
        input_tokens: raw.inputTokens,
        output_tokens: raw.outputTokens,
        cache_read_input_tokens: raw.cacheReadInputTokens,
        cache_creation_input_tokens: raw.cacheCreationInputTokens,
        output_tokens_details: { reasoning_tokens: raw.thinkingTokens },
      })),
    });
    const total = normalizeTokens(measurement);
    return {
      scope: "query-pipeline",
      measurement,
      byModel,
      complete: total.input !== null && total.output !== null,
    };
  }
  const usage = object(event.usage);
  if (
    (event.subtype !== "success" || event.is_error === true) &&
    usage.input_tokens === 0 &&
    usage.output_tokens === 0
  )
    return null;
  const measurement = tokenMeasurement("claude", usage);
  return Object.keys(measurement.raw).length
    ? {
        scope: "main-loop",
        measurement,
        byModel: [],
        complete: false,
      }
    : null;
}
export function codexUsage(value: unknown): RuntimeUsage | null {
  const total = object(object(value).total);
  const measurement = tokenMeasurement("codex", {
    input_tokens: total.inputTokens,
    output_tokens: total.outputTokens,
    total_tokens: total.totalTokens,
    input_tokens_details: { cached_tokens: total.cachedInputTokens },
    output_tokens_details: { reasoning_tokens: total.reasoningOutputTokens },
  });
  if (!Object.keys(measurement.raw).length) return null;
  const t = normalizeTokens(measurement);
  return {
    scope: "thread-cumulative",
    native: Object.fromEntries(
      Object.entries(total).filter(
        ([key, value]) =>
          [
            "inputTokens",
            "outputTokens",
            "totalTokens",
            "cachedInputTokens",
            "reasoningOutputTokens",
          ].includes(key) && count(value),
      ),
    ) as Record<string, number>,
    measurement,
    byModel: [],
    complete: t.input !== null && t.output !== null,
  };
}
