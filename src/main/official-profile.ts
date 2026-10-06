import { isAbsolute, join } from "node:path";
import type { Provider, ProviderEvent } from "./providers/provider.js";

/** An explicit official-only profile never installs legacy credential readers. */
export function officialProfile(argv: readonly string[], home?: string) {
  if (!argv.includes("--official-only")) return undefined;
  if (!home || !isAbsolute(home))
    throw new Error("--official-only は絶対パスの XHARNESS_HOME が必要です");
  return join(home, "electron-user-data");
}

export function unavailableLegacy(id: "claude" | "codex"): Provider {
  return {
    id,
    models: () => [],
    async *stream(): AsyncIterable<ProviderEvent> {
      yield {
        type: "error",
        error: {
          kind: "request",
          message:
            "公式専用プロファイルです。「公式workflow」から操作してください。",
          retryable: false,
        },
      };
    },
  };
}
