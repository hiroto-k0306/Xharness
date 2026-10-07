import {
  query,
  type Query,
  type SDKUserMessage,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { BoundaryError } from "./contracts.js";
import { officialSdkBinding } from "./sdk-binding.js";
import type { SdkOptions } from "./claude.js";

type PersonalQuery = Pick<
  Query,
  | "accountInfo"
  | "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"
  | "close"
  | typeof Symbol.asyncIterator
>;
export type PersonalStart = (request: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => PersonalQuery;
export class PersonalApprovalError extends BoundaryError {
  constructor(
    readonly reason: string,
    readonly status: "unconfigured" | "needs_auth" = "unconfigured",
  ) {
    super("unconfigured");
  }
}

/** SDK owns authentication. No credential-file reader, login, account identifiers or raw errors leave here. */
export async function approvePersonalQuery(
  active: PersonalQuery,
  onUsage?: (
    usage: Awaited<
      ReturnType<
        PersonalQuery["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"]
      >
    >,
  ) => void,
): Promise<void> {
  const account = await active.accountInfo();
  if (account.apiProvider !== "firstParty")
    throw new PersonalApprovalError(
      "公式SDKの接続先がfirst-partyではありません。API・クラウド経路では送信しません。",
    );
  if (account.apiKeySource)
    throw new PersonalApprovalError(
      "公式SDKがAPIキー認証経路を報告しました。サブスク経路ではないため送信しません。",
    );
  if (!account.subscriptionType)
    throw new PersonalApprovalError(
      "公式SDKがサブスク認証を報告しませんでした。本人が公式Claudeログインを確認してください。",
      "needs_auth",
    );
  const usage =
    await active.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
      skipBehaviors: true,
    });
  if (!usage.subscription_type || !usage.rate_limits_available)
    throw new PersonalApprovalError(
      "公式SDKでサブスクのUsage枠を取得できませんでした。認証・通信状態を確認してください。",
    );
  if (usage.rate_limits?.extra_usage?.is_enabled === true)
    throw new PersonalApprovalError(
      "アカウントのExtra Usageが有効です。追加課金なしの今回の条件を満たしません。本人がUsage設定を確認してください。",
    );
  if (usage.rate_limits?.extra_usage?.is_enabled !== false)
    throw new PersonalApprovalError(
      "公式SDKからExtra Usage無効の値を取得できませんでした。不明のまま送信しません。",
    );
  onUsage?.(usage);
}

async function approvalWithAbort(active: PersonalQuery, signal: AbortSignal) {
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(new BoundaryError("cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    await Promise.race([approvePersonalQuery(active), cancelled]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function heldQuery(options: Options, start: PersonalStart) {
  let release!: (value: string | undefined) => void;
  const held = new Promise<string | undefined>((resolve) => {
    release = resolve;
  });
  const active = start({
    options: { ...options, stderr: () => {} },
    prompt: (async function* () {
      const text = await held;
      if (text !== undefined)
        yield {
          type: "user",
          session_id: "",
          message: { role: "user", content: text },
          parent_tool_use_id: null,
        };
    })(),
  });
  const close = () => {
    active.close();
    release(undefined);
  };
  options.abortController?.signal.addEventListener("abort", close, {
    once: true,
  });
  return {
    active,
    release,
    close,
    cleanup: () =>
      options.abortController?.signal.removeEventListener("abort", close),
  };
}

/** Rechecks route/overage before each model prompt, in that same official SDK process. */
export function personalSdkBinding(
  cwd: string,
  start: PersonalStart = query,
  onUnavailable?: (
    reason: string,
    status: "unconfigured" | "needs_auth",
  ) => void,
) {
  return officialSdkBinding(
    { cwd, env: process.env, subscriptionOnlyConfirmed: true },
    (request) => {
      const held = heldQuery(request.options!, start);
      return {
        close: held.close,
        async *[Symbol.asyncIterator]() {
          try {
            try {
              await approvalWithAbort(
                held.active,
                request.options!.abortController!.signal,
              );
            } catch (error) {
              if (!request.options!.abortController!.signal.aborted)
                onUnavailable?.(
                  error instanceof PersonalApprovalError
                    ? error.reason
                    : "公式SDKの正規接続確認に失敗しました。本人が認証・通信状態を確認してください。",
                  error instanceof PersonalApprovalError
                    ? error.status
                    : "needs_auth",
                );
              throw error;
            }
            request.options?.abortController?.signal.throwIfAborted();
            if (typeof request.prompt !== "string")
              throw new BoundaryError("unsupported");
            held.release(request.prompt);
            yield* held.active;
          } finally {
            held.close();
            held.cleanup();
          }
        },
      };
    },
  );
}

/** Explicit UI check: no model input, no history scan, no inference. Availability is memory-only. */
export async function checkPersonalSdk(
  cwd: string,
  signal: AbortSignal,
  start: PersonalStart = query,
  onUnavailable?: (
    reason: string,
    status: "unconfigured" | "needs_auth",
  ) => void,
): Promise<boolean> {
  const abortController = new AbortController();
  const cancel = () => abortController.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(cancel, 60_000);
  // The binding supplies the same sanitized environment as real execution.
  let result = false;
  const binding = officialSdkBinding(
    { cwd, env: process.env, subscriptionOnlyConfirmed: true },
    (request) => {
      const held = heldQuery(request.options!, start);
      return {
        close: held.close,
        async *[Symbol.asyncIterator]() {
          try {
            await approvalWithAbort(held.active, abortController.signal);
            abortController.signal.throwIfAborted();
            result = true;
          } finally {
            held.close();
            held.cleanup();
          }
        },
      };
    },
  );
  const options: SdkOptions = {
    model: "haiku",
    tools: [],
    allowedTools: [],
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    maxTurns: 1,
    systemPrompt: "",
    permissionMode: "dontAsk",
    persistSession: false,
    abortController,
    hooks: { PreToolUse: [{ hooks: [async () => ({})] }] },
    canUseTool: async () => ({ behavior: "deny", message: "No tools" }),
  };
  try {
    for await (const _ of binding.query({ prompt: "", options })) {
      void _;
    }
  } catch (error) {
    result = false;
    if (!signal.aborted)
      onUnavailable?.(
        error instanceof PersonalApprovalError
          ? error.reason
          : "公式SDKの初期化・正規接続確認に失敗しました。本人が公式Claude認証と通信状態を確認してください。",
        error instanceof PersonalApprovalError ? error.status : "needs_auth",
      );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
  return result;
}
