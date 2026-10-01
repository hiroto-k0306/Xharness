import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ModelInfo,
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
} from "../provider.js";
import { decodeClaudeStream } from "../claude/stream.js";
import { decodeCodexStream } from "../codex/stream.js";
import { type ProviderId } from "../../core/types.js";
import { claudeUsage } from "../claude/usage.js";
import { codexUsage } from "../codex/usage.js";
import { phase5Demo } from "./phase5-demo.js";

/** FakeProvider が1回の stream() で再現する応答。 */
export type FakeStep =
  | {
      type: "message";
      message: import("../../core/types.js").Message;
      stopReason: "end_turn" | "tool_use";
    }
  | {
      /** test/fixtures/claude/<name>.json の SSE を実際の Claude デコーダ経由で再生する */
      type: "fixture";
      name: string;
      /** 先頭から N 個の SSE イベントで回線が切れる(途中中断の再現) */
      cutAfterEvents?: number;
      /** イベント間の待ち時間。AbortSignal での中断を試すときに使う */
      delayMs?: number;
    }
  | { type: "rate_limited"; retryAfterSec?: number; scope?: string }
  | { type: "error"; kind: "transport" | "request" | "authentication" };

export interface FakeProviderOptions {
  quota?: boolean;
  provider?: ProviderId;
  /** 既定: <cwd>/test/fixtures/claude */
  fixturesDir?: string;
  /** 与えると順番に消費する。尽きたら keyword ルーティングへ戻る */
  script?: FakeStep[];
  /** 受け取った要求を観測する(テスト用) */
  onRequest?(request: ProviderRequest): void;
}

interface FixtureFile {
  responseHeaders?: { all: Record<string, string> };
  status: number;
  events: { event: string; data: string }[];
}

function lastUserText(request: ProviderRequest): string {
  const last = request.messages.at(-1);
  if (!last || last.role !== "user") return "";
  return last.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n");
}
function endsWithToolResult(request: ProviderRequest): boolean {
  return !!request.messages
    .at(-1)
    ?.content.some((block) => block.type === "tool_result");
}

/**
 * 既定のルーティング(--fake で使う)。最後のユーザー発言のキーワードで選ぶ:
 *   "read"  → Read ツール呼び出し(続くツール結果には最終テキストで返す)
 *   "429"   → rate_limited
 *   "cut"   → 途中で回線が切れる
 *   "slow"  → イベント間に遅延(Esc / 中断の確認用)
 *   他      → pong のテキスト応答
 */
export function routeFake(
  request: ProviderRequest,
  provider: ProviderId = "claude",
): FakeStep {
  const demo = phase5Demo(request);
  if (demo) return demo;
  if (request.webSearch)
    return {
      type: "fixture",
      name: provider === "codex" ? "phase3-web-live" : "phase3-web-haiku",
    };
  if (provider === "codex") {
    if (endsWithToolResult(request))
      return { type: "fixture", name: "x3-tool-2" };
    const text = lastUserText(request).toLowerCase();
    if (text.includes("429")) return { type: "rate_limited", retryAfterSec: 3 };
    if (text.includes("read") || text.includes("tool"))
      return { type: "fixture", name: "x3-tool-1" };
    return {
      type: "fixture",
      name: "x2-gpt-6-luna",
      ...(text.includes("cut") ? { cutAfterEvents: 4 } : {}),
      ...(text.includes("slow") ? { delayMs: 400 } : {}),
    };
  }
  if (endsWithToolResult(request))
    return { type: "fixture", name: "phase1-headless-read-2" };
  const text = lastUserText(request).toLowerCase();
  if (text.includes("429")) return { type: "rate_limited", retryAfterSec: 3 };
  if (text.includes("cut"))
    return { type: "fixture", name: "phase1-haiku-text", cutAfterEvents: 4 };
  if (text.includes("slow"))
    return { type: "fixture", name: "phase1-haiku-text", delayMs: 400 };
  if (text.includes("read"))
    return { type: "fixture", name: "phase1-headless-read-1" };
  return { type: "fixture", name: "phase1-haiku-text" };
}

function sse(events: { event: string; data: string }[]): Response {
  const bytes = new TextEncoder().encode(
    events.map((e) => `event: ${e.event}\r\ndata: ${e.data}\r\n\r\n`).join(""),
  );
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  );
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      reject(new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", done);
      resolve();
    }, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * 通信しない Provider。fixtures の SSE を ClaudeAdapter と同じデコーダで再生する。
 * 認証情報は読まない・要求しない。DESIGN.md §6 の Provider に準拠。
 */
export class FakeProvider implements Provider {
  readonly id: ProviderId;
  private readonly script: FakeStep[];
  constructor(private readonly options: FakeProviderOptions = {}) {
    this.script = [...(options.script ?? [])];
    this.id = options.provider ?? "claude";
  }
  models(): ModelInfo[] {
    return this.id === "codex"
      ? ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"].map((id) => ({
          id,
          contextTokens: 272000,
        }))
      : [
          "fake",
          "claude-haiku-4-5-20251001",
          "claude-opus-5-5",
          "claude-sonnet-5-5",
        ].map((id) => ({
          id,
          contextTokens: id.includes("haiku") ? 200000 : 1000000,
        }));
  }
  private async load(name: string): Promise<FixtureFile> {
    if (!/^[\w.-]+$/.test(name)) throw new Error("Invalid fixture name");
    const dir =
      this.options.fixturesDir ?? join(process.cwd(), "test/fixtures", this.id);
    return JSON.parse(
      await readFile(join(dir, `${name}.json`), "utf8"),
    ) as FixtureFile;
  }
  async *stream(
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    this.options.onRequest?.(structuredClone(request));
    const step = this.script.shift() ?? routeFake(request, this.id);
    try {
      signal.throwIfAborted();
      if (step.type === "message") {
        const message = structuredClone(step.message);
        message.meta = {
          ...message.meta,
          provider: this.id,
          model: request.model,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        for (const block of step.message.content) {
          if (block.type === "text")
            yield { type: "text_delta", text: block.text };
          if (block.type === "tool_use")
            yield {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input,
            };
        }
        yield {
          type: "message_done",
          message,
          stopReason: step.stopReason,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        return;
      }
      if (step.type === "rate_limited") {
        yield {
          type: "rate_limited",
          retryAfterSec: step.retryAfterSec,
          scope: step.scope,
        };
        return;
      }
      if (step.type === "error") {
        yield {
          type: "error",
          error: {
            kind: step.kind,
            message: `Fake ${step.kind} error`,
            retryable: step.kind === "transport",
          },
        };
        return;
      }
      const file = await this.load(step.name);
      if (this.options.quota)
        yield {
          type: "usage",
          provider: this.id,
          ...(this.id === "claude" ? claudeUsage : codexUsage)(
            new Headers(file.responseHeaders?.all),
          ),
        };
      const events =
        step.cutAfterEvents === undefined
          ? file.events
          : file.events.slice(0, step.cutAfterEvents);
      let completed = false;
      for await (const event of (this.id === "codex"
        ? decodeCodexStream
        : decodeClaudeStream)(sse(events))) {
        signal.throwIfAborted();
        if (step.delayMs) await sleep(step.delayMs, signal);
        if (event.type === "message_done") completed = true;
        yield event;
      }
      // 切断されたストリームは message_done が出ない。実 Adapter と同様にエラーで終える。
      if (!completed)
        yield {
          type: "error",
          error: {
            kind: "transport",
            message: "Fake stream cut",
            retryable: false,
          },
        };
    } catch {
      yield {
        type: "error",
        error: {
          kind: signal.aborted ? "aborted" : "protocol",
          message: signal.aborted
            ? "Fake request aborted"
            : "Fake stream failed",
          retryable: false,
        },
      };
    }
  }
}
