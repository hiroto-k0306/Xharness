import { type ProviderId } from "../core/types.js";

export interface TokenMeasurement {
  provider: ProviderId;
  /** Numeric provider fields only. No request, response text or credentials. */
  raw: Record<string, unknown>;
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const count = (v: unknown): number | null =>
  Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null;

/** Preserve omissions rather than supplying zero; whitelist the usage schema. */
export function tokenMeasurement(
  provider: ProviderId,
  value: unknown,
): TokenMeasurement {
  const source = object(value);
  const raw: Record<string, unknown> = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "total_tokens",
  ]) {
    if (count(source[key]) !== null) raw[key] = source[key];
  }
  for (const [key, field] of [
    ["input_tokens_details", "cached_tokens"],
    ["output_tokens_details", "reasoning_tokens"],
  ] as const) {
    const n = count(object(source[key])[field!]);
    if (n !== null) raw[key!] = { [field!]: n };
  }
  if (Array.isArray(source.iterations) && source.iterations.length)
    raw.iterations = source.iterations.map(
      (v) => tokenMeasurement(provider, v).raw,
    );
  return { provider, raw };
}

export interface TokenTotals {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  total: number | null;
}
const sum = (values: (number | null)[]) => {
  if (values.some((v) => v === null)) return null;
  const total = values.reduce<number>((n, v) => n + v!, 0);
  return Number.isSafeInteger(total) ? total : null;
};

export function normalizeTokens(measurement: TokenMeasurement): TokenTotals {
  const { provider, raw } = measurement;
  if (Array.isArray(raw.iterations) && raw.iterations.length) {
    const iterations = raw.iterations.map((v) =>
      normalizeTokens(tokenMeasurement(provider, v)),
    );
    return Object.fromEntries(
      ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"].map(
        (key) => [key, sum(iterations.map((v) => v[key as keyof TokenTotals]))],
      ),
    ) as unknown as TokenTotals;
  }
  const input = count(raw.input_tokens);
  const output = count(raw.output_tokens);
  const cacheRead =
    provider === "claude"
      ? count(raw.cache_read_input_tokens)
      : count(object(raw.input_tokens_details).cached_tokens);
  const cacheWrite =
    provider === "claude" ? count(raw.cache_creation_input_tokens) : null;
  const reasoning = count(object(raw.output_tokens_details).reasoning_tokens);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    // OpenAI cache/reasoning are subsets; Anthropic cache is additional input.
    total: sum(
      provider === "claude"
        ? [input, cacheRead, cacheWrite, output]
        : [input, output],
    ),
  };
}
