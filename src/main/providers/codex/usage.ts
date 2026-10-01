import { type QuotaUsage } from "../provider.js";

export function codexUsage(headers: Headers): QuotaUsage {
  const read = (name: string) => {
    const raw = headers.get(name);
    if (raw === null || !raw.trim()) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const windows = ["primary", "secondary"].flatMap((name) => {
    const usedPercent = read(`x-codex-${name}-used-percent`);
    const windowMinutes = read(`x-codex-${name}-window-minutes`);
    const resetSeconds = read(`x-codex-${name}-reset-at`);
    const resetAt =
      resetSeconds !== undefined && resetSeconds * 1000 <= 8.64e15
        ? resetSeconds
        : undefined;
    if (
      usedPercent === undefined &&
      windowMinutes === undefined &&
      resetAt === undefined
    )
      return [];
    return [
      {
        name,
        usedPercent,
        windowMinutes,
        ...(resetAt === undefined
          ? {}
          : { resetAt: new Date(resetAt * 1000).toISOString() }),
      },
    ];
  });
  return { windows };
}

export function codexRetryAfter(
  headers: Headers,
  now: number,
): number | undefined {
  const retry = headers.get("retry-after");
  if (retry !== null) {
    const seconds = Number(retry);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const date = Date.parse(retry);
    if (Number.isFinite(date))
      return Math.max(0, Math.ceil((date - now) / 1000));
  }
  const windows = codexUsage(headers).windows;
  const exhausted = windows.filter((w) => (w.usedPercent ?? 0) >= 100);
  const waits = exhausted.flatMap((w) =>
    w.resetAt
      ? [Math.max(0, Math.ceil((Date.parse(w.resetAt) - now) / 1000))]
      : [],
  );
  return waits.length ? Math.max(...waits) : undefined;
}
