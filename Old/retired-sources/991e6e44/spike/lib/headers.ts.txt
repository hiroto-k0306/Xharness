import { isSensitiveKey, maskSecrets } from "./mask.js";

export interface HeaderReport {
  all: Record<string, string>;
  usage: Record<string, string>;
}

export function inspectHeaders(
  headers: Headers,
  secrets: readonly string[] = [],
): HeaderReport {
  const entries = [...headers].filter(([name]) => !isSensitiveKey(name));
  const all = maskSecrets(Object.fromEntries(entries), secrets) as Record<
    string,
    string
  >;
  return {
    all,
    usage: Object.fromEntries(
      Object.entries(all).filter(([name]) =>
        /ratelimit|limit|usage|reset|retry|used-percent|window-minutes|utilization/i.test(
          name,
        ),
      ),
    ),
  };
}
