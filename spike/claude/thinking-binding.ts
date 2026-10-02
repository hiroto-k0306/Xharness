// 安定化レビュー対応の実送信確認(手元の Windows で実行する。クラウドでは実行しない)。
//
//   pnpm spike:claude:thinking-binding -- --yes
//
// Opus 5.5 への要求すべてに、2026-08-31 以降のアカウントと同じ検査を明示的に有効にして送る:
//   anthropic-beta: thinking-binding-controls-2026-08-01
//   thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } }
// 前提(system・tools・それより前のメッセージ)が変わっていれば 400 になる。
//
// (a) 実際の WorkflowRuntime で classify → implement の切り替えをまたぐ(SkipPlan → 応答)
// (b) その履歴をサーバー側で圧縮し(compact-2026-09-04)、圧縮ブロックを先頭にして1往復続ける
// Claude の送信は最大4回(spike/.out/budget-thinking-binding/ に予約を記録)。Codex には送らない。
// 資格情報は公式 CLI のファイルを読むだけ。トークン・本文は保存しない。
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAgentConfig } from "../../src/main/agents/definitions.js";
import { prepareProviderHistory } from "../../src/main/context/provider-compactor.js";
import { Router } from "../../src/main/core/router.js";
import { type Message } from "../../src/main/core/types.js";
import { ClaudeAdapter } from "../../src/main/providers/claude/adapter.js";
import { defaultTools } from "../../src/main/session/context.js";
import { WorkflowRuntime } from "../../src/main/workflow/runtime.js";
import { reserveRequest } from "../lib/budget.js";

export const MODEL = "claude-opus-5-5";
export const BINDING_BETA = "thinking-binding-controls-2026-08-01";
export const LIMIT = 4;

export interface Sent {
  step: string;
  status: number;
  /** 400 のときだけ: 失敗したブロックの位置を示すエラー文の先頭(秘密値は含まれない) */
  error?: string;
}

/**
 * 実際の Adapter の送信に、検査を有効にするヘッダと thinking 設定を足す fetch。
 * 送信前に予算を予約し、上限を超える送信はしない。
 */
export function bindingFetcher(
  sent: Sent[],
  step: () => string,
  options: {
    fetcher?: typeof fetch;
    reserve?: () => Promise<number>;
  } = {},
): typeof fetch {
  const reserve =
    options.reserve ??
    (() =>
      reserveRequest("claude", `thinking-binding-${step()}`, ".", {
        bucket: "thinking-binding",
        limit: LIMIT,
      }));
  return async (input, init) => {
    await reserve();
    const headers = new Headers(init?.headers);
    const betas = (headers.get("anthropic-beta") ?? "")
      .split(",")
      .filter(Boolean);
    if (!betas.includes(BINDING_BETA)) betas.push(BINDING_BETA);
    headers.set("anthropic-beta", betas.join(","));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    body.thinking = {
      type: "adaptive",
      block_binding: { prefix_mismatch_behavior: "error" },
    };
    const response = await (options.fetcher ?? fetch)(input, {
      ...init,
      headers,
      body: JSON.stringify(body),
    });
    const entry: Sent = { step: step(), status: response.status };
    if (!response.ok) {
      const text = await response.clone().text();
      try {
        const message = String(
          (JSON.parse(text) as { error?: { message?: unknown } }).error
            ?.message ?? "",
        );
        entry.error = message.slice(0, 300);
      } catch {
        entry.error = "unparseable error body";
      }
    }
    sent.push(entry);
    return response;
  };
}

export async function main(
  argv = process.argv.slice(2),
  /** 試験用: 実通信の代わりに使う fetch と予約(通常は指定しない) */
  test: {
    fetcher?: typeof fetch;
    reserve?: () => Promise<number>;
    getAccessToken?: () => Promise<string>;
  } = {},
) {
  if (!argv.includes("--yes")) {
    console.error(
      `Sends up to ${LIMIT} requests to ${MODEL} with ${BINDING_BETA}. Re-run with --yes to proceed.`,
    );
    process.exitCode = 1;
    return;
  }
  const sent: Sent[] = [];
  let step = "a-workflow";
  const provider = new ClaudeAdapter({
    fetcher: bindingFetcher(sent, () => step, test),
    ...(test.getAccessToken ? { getAccessToken: test.getAccessToken } : {}),
  });
  const home = await mkdtemp(join(tmpdir(), "xh-binding-home-"));
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  await writeFile(join(cwd, "note.txt"), "binding check\n");
  const config = await loadAgentConfig(home);
  const runtime = new WorkflowRuntime({
    home,
    cwd,
    parentId: "binding-check",
    config,
    router: new Router([provider]),
    createTools: (dir) => defaultTools(dir, false),
    permission: async () => false,
    approve: async () => false,
  });
  const report: Record<string, unknown> = { model: MODEL, sent };
  // (a) classify で SkipPlan を呼ばせ、implement に移った次の要求で前の thinking を返す
  const result = await runtime.run(
    {
      provider,
      model: MODEL,
      reasoning: { effort: "low" },
      system:
        "You are a coding agent. This is a short connectivity check. Keep every reply under 10 words.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: 'Call SkipPlan with reason "binding check" first. After it returns, reply exactly "done" and do not call any other tool.',
            },
          ],
        },
      ],
      tools: defaultTools(cwd, false),
      permission: async () => false,
      maxRounds: 2,
    },
    new AbortController().signal,
  );
  const aRequests = sent.filter((s) => s.step === "a-workflow").length;
  const skipPlanCalled = result.messages.some((m) =>
    m.content.some((b) => b.type === "tool_use" && b.name === "SkipPlan"),
  );
  report.workflow = {
    stopCause: result.stopCause,
    requests: aRequests,
    // 段階の切り替えをまたいだか(SkipPlan で classify → implement、その後にもう1回送信)
    phaseSwitched: skipPlanCalled && aRequests >= 2,
    phase: runtime.state.phase,
    thinkingBlocks: result.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === "reasoning").length,
  };
  // (b) 完了した会話をサーバー側で圧縮し、ブロックを先頭にして続ける
  const tools = [...defaultTools(cwd, false).values()].map((t) => t.spec);
  if (sent.length < LIMIT && sent.every((s) => s.status === 200)) {
    step = "b-compact";
    const system = "You are a coding agent. Keep every reply under 10 words.";
    const compacted = await prepareProviderHistory(result.messages, {
      provider,
      model: MODEL,
      system,
      tools,
      threshold: 0.8,
      force: true,
      signal: AbortSignal.timeout(120000),
    });
    step = "b-continue";
    const messages: Message[] = [
      ...compacted.messages,
      { role: "user", content: [{ type: "text", text: 'Reply "ok".' }] },
    ];
    let stopReason: string | undefined;
    for await (const event of provider.stream(
      { model: MODEL, system, tools, messages, maxOutputTokens: 256 },
      AbortSignal.timeout(120000),
    ))
      if (event.type === "message_done") stopReason = event.stopReason;
    report.compaction = {
      compacted: compacted.compacted,
      blockFirst: compacted.messages[0]?.content[0]?.type === "compaction",
      continuationStopReason: stopReason,
    };
  } else
    report.compaction = "skipped (an earlier request failed or budget used)";
  report.passed =
    (report.workflow as { phaseSwitched: boolean }).phaseSwitched &&
    sent.length > 0 &&
    sent.every((s) => s.status === 200) &&
    (report.compaction as { continuationStopReason?: string })
      ?.continuationStopReason !== undefined;
  if (!test.fetcher) {
    const out = resolve("spike", ".out", "thinking-binding.json");
    await mkdir(resolve("spike", ".out"), { recursive: true });
    await writeFile(out, JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
  return report;
}

if (process.argv[1]?.endsWith("thinking-binding.ts"))
  main().catch((error: unknown) => {
    console.error(
      "Thinking-binding check failed:",
      error instanceof Error ? error.message.slice(0, 200) : "unknown",
    );
    process.exitCode = 1;
  });
