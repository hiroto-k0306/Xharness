export function claudeRateLimit(headers: Headers, nowMs: number) {
  const prefix = "anthropic-ratelimit-unified-";
  const claim = headers.get(`${prefix}representative-claim`);
  const scope =
    claim === "five_hour" ? "5h" : claim === "seven_day" ? "7d" : undefined;
  const parse = (key: string): number | undefined => {
    const raw = headers.get(key);
    if (raw === null || !/^\d+(?:\.\d+)?$/.test(raw)) return undefined;
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  };
  const claimedReset = scope ? parse(`${prefix}${scope}-reset`) : undefined;
  const unifiedReset = parse(`${prefix}reset`);
  const resets = [...headers.keys()]
    .filter((key) => key.startsWith(prefix) && key.endsWith("-reset"))
    .map(parse)
    .filter((value): value is number => value !== undefined);
  const reset =
    claimedReset ??
    unifiedReset ??
    (resets.length ? Math.max(...resets) : undefined);
  return {
    retryAfterSec:
      reset === undefined
        ? undefined
        : Math.max(0, Math.ceil(reset - nowMs / 1000)),
    scope,
  };
}
