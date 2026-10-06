import type {
  ConnectionChoice,
  ConnectionView,
} from "../../shared/connections.js";
import type { ConnectionSelection } from "./integration.js";
import { checkPersonalSdk, personalSdkBinding } from "./personal-sdk.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface UiConnections {
  views(): ConnectionView[];
  check(signal: AbortSignal): Promise<void>;
  selection(
    mode: Exclude<ConnectionChoice, "legacy">,
    cwd: string,
  ): Omit<ConnectionSelection, "taskId"> | undefined;
}
export const connectionLabels: Record<ConnectionChoice, string> = {
  legacy: "既存方式",
  "openai-siwc": "OpenAI SIWC",
  "claude-proposals": "Claude Agent / X実行",
  "claude-mcp": "Claude Agent / X MCP",
};
export function unavailableConnections(): ConnectionView[] {
  return [
    {
      mode: "legacy",
      label: connectionLabels.legacy,
      status: "available",
      reason: "既存の接続・認証設定を使用",
    },
    {
      mode: "openai-siwc",
      label: connectionLabels["openai-siwc"],
      status: "unconfigured",
      reason:
        "専用の発行済みclient ID・独立したplan-use認可・SIWC transportが未登録。CLI資格情報では代用しません。",
    },
    ...(["claude-proposals", "claude-mcp"] as const).map((mode) => ({
      mode,
      label: connectionLabels[mode],
      status: "needs_auth" as const,
      reason:
        "本人の開発用。公式SDKの正規サブスク接続とExtra Usage無効を接続確認してください。第三者向け配布の認可とは別です。",
    })),
  ];
}
/** Only supplied to unpackaged development UI; never logs in or edits installed settings. */
export function developmentUiConnections(
  home: string,
  fake: boolean,
): UiConnections {
  let available = false;
  const views = unavailableConnections();
  const unavailable = (
    reason: string,
    status: "unconfigured" | "needs_auth",
  ) => {
    available = false;
    for (const view of views.slice(2)) {
      view.status = status;
      view.reason = reason;
    }
  };
  if (fake)
    for (const view of views.slice(2)) {
      view.status = "available";
      view.reason = "fake：通信せず固定応答で接続操作を検証";
    }
  return {
    views: () => structuredClone(views),
    async check(signal) {
      if (fake) return;
      const cwd = join(home, "connection-check");
      await mkdir(cwd, { recursive: true });
      const checked = await checkPersonalSdk(
        cwd,
        signal,
        undefined,
        unavailable,
      );
      if (signal.aborted) return;
      available = checked;
      for (const view of views.slice(2)) {
        if (checked) view.status = "available";
        if (checked)
          view.reason =
            "公式SDKでfirst-partyサブスク・Extra Usage無効を確認。送信前にも再確認します。";
      }
    },
    selection(mode, cwd) {
      if (mode === "openai-siwc" || (!fake && !available)) return undefined;
      return {
        mode,
        ...(fake
          ? {
              simulated: true,
              sdk: {
                subscriptionUseConfirmed: true,
                createXServer: (h) => h,
                async *query() {
                  yield {
                    type: "result",
                    subtype: "success",
                    result: "OK",
                    structured_output: { answer: "OK", actions: [] },
                    usage: {
                      input_tokens: 2,
                      output_tokens: 1,
                      cache_read_input_tokens: 0,
                      cache_creation_input_tokens: 0,
                    },
                  };
                },
              },
            }
          : { sdk: personalSdkBinding(cwd, undefined, unavailable) }),
      };
    },
  };
}
