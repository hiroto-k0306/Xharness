import { type QuotaUsage } from "../provider.js";
export function claudeUsage(headers: Headers): QuotaUsage {
  const number = (key: string) => {
    const value = headers.get(key);
    if (value === null || !value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  return {
    windows: (
      [
        ["5h", 300],
        ["7d", 10080],
      ] as const
    ).flatMap(([name, windowMinutes]) => {
      const prefix = `anthropic-ratelimit-unified-${name}-`;
      const utilization = number(prefix + "utilization");
      const reset = number(prefix + "reset");
      if (utilization === undefined && reset === undefined) return [];
      return [
        {
          name,
          windowMinutes,
          usedPercent:
            utilization === undefined ? undefined : utilization * 100,
          ...(reset !== undefined && reset * 1000 <= 8.64e15
            ? { resetAt: new Date(reset * 1000).toISOString() }
            : {}),
        },
      ];
    }),
  };
}
