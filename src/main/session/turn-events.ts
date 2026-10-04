// 1ターンの間、Agent Loop / workflow のイベントを画面用の UiEvent と Receipt に変換する。
import { resolveModel } from "../config/config.js";
import { type LoopOptions } from "../core/loop.js";
import { STEP_NODES, type Receipt, type UiEvent } from "../../shared/ipc.js";
import { type StoredSession } from "./store.js";
import {
  pad,
  safeInput,
  toReceipt,
  type ControllerContext,
  type Runtime,
} from "./context.js";

type LoopEvent = Parameters<NonNullable<LoopOptions["onEvent"]>>[0];

type UsageEvent = Extract<UiEvent, { type: "usage" }>;

/** Router の割り当て判断に使う、プロバイダごとの5時間枠の使用率を更新する */
export function updateQuota(ctx: ControllerContext, event: UsageEvent) {
  const used =
    event.windows?.find((w) => w.windowMinutes === 300)?.usedPercent ??
    event.window5h;
  if (typeof used === "number" && Number.isFinite(used))
    ctx.quota[event.provider] = used;
  // 枠ごとに最新の値を残す(イベントに一部の枠しか無いときも、ほかの枠を消さない)
  const windows = new Map(
    (ctx.usage[event.provider] ?? []).map((w) => [
      w.windowMinutes ?? w.name,
      w,
    ]),
  );
  const incoming = [...(event.windows ?? [])];
  for (const [name, windowMinutes, usedPercent] of [
    ["5h", 300, event.window5h],
    ["7d", 10080, event.weekly],
  ] as const)
    if (
      usedPercent !== undefined &&
      !incoming.some((w) => w.windowMinutes === windowMinutes)
    )
      incoming.push({ name, windowMinutes, usedPercent });
  for (const w of incoming) {
    const key = w.windowMinutes ?? w.name;
    const previous = windows.get(key);
    windows.set(key, {
      ...previous,
      ...w,
      usedPercent: Number.isFinite(w.usedPercent)
        ? w.usedPercent
        : previous?.usedPercent,
      resetAt: w.resetAt ?? previous?.resetAt,
    });
  }
  ctx.usage[event.provider] = [...windows.values()];
}

/** 使用量イベントを §16.7 の表示用(5時間枠・週間枠)に整える */
export function shapeUsage(event: UsageEvent): UsageEvent {
  return {
    type: "usage",
    provider: event.provider,
    windows: event.windows,
    window5h:
      event.windows?.find((w) => w.windowMinutes === 300)?.usedPercent ??
      event.window5h,
    weekly:
      event.windows?.find((w) => w.windowMinutes === 10080)?.usedPercent ??
      event.weekly,
  };
}

/** 枠の使用率を更新してから、表示用に整える */
export function usageEvent(
  ctx: ControllerContext,
  event: UsageEvent,
): UsageEvent {
  updateQuota(ctx, event);
  return shapeUsage({ ...event, windows: ctx.usage[event.provider] });
}

export class TurnEvents {
  /** ターン終了時に保存の完了を待つレシート書き込み */
  readonly receiptWrites: Promise<void>[] = [];
  /** tool_use の ID → 画面のツールカード番号 */
  readonly receiptByCall = new Map<string, string>();
  activeProvider: string;
  private readonly calls: { callId: string; receiptId: string }[] = [];
  private buffer = "";

  constructor(
    private readonly ctx: ControllerContext,
    private readonly session: StoredSession,
    private readonly rt: Runtime,
  ) {
    this.activeProvider = ctx.options.provider.id;
  }

  private get sessionId() {
    return this.session.id;
  }
  private messageId() {
    return `${this.sessionId}-m${this.rt.messageSeq}`;
  }
  nextReceiptId() {
    return pad(++this.rt.receiptSeq);
  }

  /** レシートを保存し(完了はターン末で待つ)、画面へ送る */
  record(receipt: Receipt) {
    const write = this.ctx.receipts.append(
      this.sessionId,
      [receipt],
      this.ctx.clean,
    );
    void write.catch(() => undefined);
    this.receiptWrites.push(write);
    (this.rt.receipts ??= []).push(receipt);
    this.ctx.options.emit({ type: "receipt", receipt });
  }

  /** 語の途中で秘密値が分割されないよう、空白までためてから送る */
  flush() {
    if (this.buffer)
      this.ctx.options.emit({
        type: "text_delta",
        sessionId: this.sessionId,
        messageId: this.messageId(),
        text: this.ctx.clean(this.buffer),
      });
    this.buffer = "";
  }

  readonly onEvent = (event: LoopEvent) => {
    const { ctx, sessionId } = this;
    const emit = ctx.options.emit;
    const clean = ctx.clean;
    switch (event.type) {
      case "tool_progress":
        emit({ ...event, sessionId });
        break;
      case "usage":
        emit(usageEvent(ctx, event));
        break;
      case "step":
        emit({
          type: "step",
          sessionId,
          step: (STEP_NODES.indexOf(event.step) + 1) as 1,
          node: event.step,
          round: event.round,
        });
        break;
      case "text_delta": {
        this.buffer += event.text;
        const cut = Math.max(
          this.buffer.lastIndexOf(" "),
          this.buffer.lastIndexOf("\n"),
          this.buffer.lastIndexOf("\t"),
        );
        if (cut >= 0) {
          const head = this.buffer.slice(0, cut + 1);
          this.buffer = this.buffer.slice(cut + 1);
          emit({
            type: "text_delta",
            sessionId,
            messageId: this.messageId(),
            text: clean(head),
          });
        }
        break;
      }
      case "message_done":
        this.flush();
        this.rt.messageSeq++;
        break;
      case "tool_use": {
        // ためていた文字を、ツールカードより先に同じ messageId で送り切る
        this.flush();
        const receiptId = this.nextReceiptId();
        this.calls.push({ callId: event.id, receiptId });
        this.receiptByCall.set(event.id, receiptId);
        emit({
          type: "tool_call",
          sessionId,
          receiptId,
          provider:
            resolveModel(
              this.rt.workflow?.mainModel ??
                (ctx.sessions.get(sessionId) ?? this.session).model,
            )?.provider ?? this.activeProvider,
          tool: event.name,
          input: safeInput(event.input, clean),
        });
        break;
      }
      case "receipt": {
        const r = event.receipt;
        if (r.provider === "hook" && !r.tool) break;
        if (r.provider === "tool") {
          const call = this.calls.shift();
          if (call)
            emit({
              type: "tool_result",
              sessionId,
              receiptId: call.receiptId,
              isError: r.decision === "error",
            });
        }
        const receipt = toReceipt(r, sessionId, this.nextReceiptId());
        receipt.input = safeInput(receipt.input, clean);
        receipt.summary = clean(receipt.summary);
        if (receipt.output) receipt.output = clean(receipt.output);
        this.record(receipt);
        break;
      }
      case "rate_limited":
        emit({
          type: "error",
          sessionId,
          message: `枠の上限(429)。待ち時間: ${event.retryAfterSec ?? "不明"} 秒`,
        });
        break;
      case "error":
        emit({
          type: "error",
          sessionId,
          message: clean(event.error.message),
        });
        break;
    }
  };
}
