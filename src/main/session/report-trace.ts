import { traceFiles } from "../core/trace-store.js";
import { readFile, stat } from "node:fs/promises";
import { traceJson, type TraceRecord } from "../core/trace.js";
import {
  requestView,
  responseView,
  messageView,
  receiptInputView,
  receiptOutputView,
  toolName,
} from "./report-readable.js";

export interface TraceReplay {
  records: TraceRecord[];
  skipped: number;
  omittedFiles?: number;
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
function object(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const steps: Record<string, string> = {
  context: "STEP 1 · 入力・履歴・ツール定義を構築",
  model: "STEP 2 · モデル呼び出しを制御",
  tool_use: "STEP 3 · ツール名と引数を検証",
  gate: "STEP 4 · 実行権限を確認",
  act: "STEP 5 · ツール実行・子への委託",
  receipt: "STEP 6 · 結果を会話に追加し、次の処理を決定",
};

export async function readTraceReplay(
  home: string,
  id: string,
  clean: (s: string) => string,
): Promise<TraceReplay | undefined> {
  try {
    const files = await traceFiles(home, id);
    if (!files.length) return undefined;
    let bytes = 0;
    let omittedFiles = 0;
    const selected: string[][] = [];
    for (const path of [...files].reverse()) {
      const size = (await stat(path)).size;
      if (files.length === 1 && size > 32_000_000)
        throw new Error("Trace exceeds size limit");
      if (bytes + size > 16_000_000) {
        omittedFiles = files.length - selected.length;
        break;
      }
      const lines = (await readFile(path, "utf8"))
        .split(/\r?\n/)
        .filter((s) => s.trim());
      if (selected.reduce((n, v) => n + v.length, 0) + lines.length > 20000) {
        omittedFiles = files.length - selected.length;
        break;
      }
      selected.unshift(lines);
      bytes += size;
    }
    const lines = selected.flat();
    const records: TraceRecord[] = [];
    let skipped = 0;
    for (const line of lines) {
      try {
        const r = JSON.parse(traceJson(JSON.parse(line), clean)) as TraceRecord;
        if (
          !r ||
          !["start", "end"].includes(r.phase) ||
          !["step", "llm", "tool", "delegation"].includes(r.kind) ||
          typeof r.id !== "string" ||
          typeof r.agentId !== "string" ||
          typeof r.label !== "string" ||
          typeof r.at !== "string" ||
          !Number.isSafeInteger(r.sequence) ||
          r.sequence < 1 ||
          [r.status, r.parentSpan, r.step, r.callId].some(
            (v) => v !== undefined && typeof v !== "string",
          ) ||
          (r.round !== undefined &&
            (!Number.isSafeInteger(r.round) || r.round < 1)) ||
          (r.simulated !== undefined && typeof r.simulated !== "boolean")
        )
          throw new Error();
        records.push(r);
      } catch {
        skipped++;
      }
    }
    return { records, skipped, omittedFiles };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Report trace could not be read");
  }
}

function callsView(value: unknown, stage?: string) {
  const calls = list(value);
  if (!calls.length) return "<p>ツールの対象なし</p>";
  return (
    calls
      .slice(0, 4)
      .map((v) => {
        const entry = object(v);
        const call = object(entry.call ?? v);
        const decision = entry.error
          ? `エラー・拒否：${entry.error === "Unknown or unavailable tool" ? "不明または利用できないツール" : entry.error === "Permission denied by user" ? "ユーザーの権限判断で拒否" : String(entry.error)}`
          : entry.allowed === true
            ? "実行を許可"
            : entry.allowed === false
              ? "実行を拒否"
              : stage === "tool_use"
                ? "検証済み"
                : "";
        return `<div class="readable-block"><p>${escape(toolName(String(call.name ?? "ツール")))} · ${escape(String(call.id ?? ""))}</p>${decision ? `<p>${escape(decision)}</p>` : ""}${entry.result ? receiptOutputView(object(entry.result).content) : receiptInputView(call.input)}</div>`;
      })
      .join("") + (calls.length > 4 ? "<p>残りは詳細に表示</p>" : "")
  );
}

export function renderTraceReplay(replay: TraceReplay) {
  const starts = replay.records
    .filter((r) => r.phase === "start")
    .sort((a, b) => a.sequence - b.sequence);
  const ends = new Map(
    replay.records.filter((r) => r.phase === "end").map((r) => [r.id, r]),
  );
  const byId = new Map(starts.map((r) => [r.id, r]));
  const previous = new Map<string, unknown>();
  const cards = starts
    .map((r, index) => {
      const end = ends.get(r.id);
      const input = object(r.input);
      const output = object(end?.output);
      const events = list(output.events).map(object);
      const complete = events.findLast((e) => e.type === "message_done");
      const dispatched =
        output.dispatched === true ||
        list(output.response).some((v) => object(v).requestDispatched === true);
      const isLlm = r.kind === "llm" && (dispatched || r.simulated);
      const title =
        r.kind === "step"
          ? (steps[r.label] ?? r.label)
          : r.kind === "llm"
            ? `${r.label} · ${r.simulated ? "LLM模擬呼び出し（実通信なし）" : dispatched ? "LLMへの送信と応答" : "LLM呼び出し準備（送信未確認）"}`
            : r.kind === "delegation"
              ? `子エージェントに委託：${r.label}`
              : toolName(r.label);
      let inputView = receiptInputView(r.input);
      let outputView = end
        ? receiptOutputView(end.output)
        : "<p>終了記録なし（実行中または記録が中断）</p>";
      if (r.kind === "llm") {
        inputView = requestView(input.internal, previous.get(r.agentId));
        previous.set(r.agentId, input.internal);
        outputView = complete
          ? responseView(complete.message)
          : `<p>${escape(end?.status ?? "終了記録なし")}</p>${events
              .filter((e) => ["error", "rate_limited"].includes(String(e.type)))
              .map((e) => receiptOutputView(e))
              .join("")}`;
      } else if (r.kind === "step") {
        inputView =
          r.label === "context"
            ? messageView(list(input.messages).at(-1))
            : r.label === "model"
              ? requestView(input.request)
              : callsView(input.calls);
        if (end)
          outputView =
            r.label === "context"
              ? requestView(output.request)
              : r.label === "model" && output.completion
                ? responseView(object(output.completion).message)
                : callsView(output.calls, r.label);
        const outcome = object(output.outcome);
        const next = outcome.to
          ? (steps[String(outcome.to)] ?? String(outcome.to))
          : outcome.kind === "retry"
            ? `同じSTEPを再試行（${String(outcome.afterMs)} ms後）`
            : outcome.kind === "stop"
              ? `停止：${String(outcome.reason)}`
              : "";
        if (next) outputView += `<p>次の処理：${escape(next)}</p>`;
        if (r.label === "receipt" && output.messagesAdded)
          outputView =
            list(output.messagesAdded).slice(0, 4).map(messageView).join("") +
            `<p>次の処理：${escape(next)}</p>`;
      } else if (r.kind === "delegation") {
        inputView = receiptInputView({
          prompt: input.prompt,
          model: input.model,
        });
        outputView = end
          ? receiptOutputView(object(end.output).text ?? end.output)
          : outputView;
        inputView += `<p>子ID：${escape(String(input.childId ?? "未記録"))}</p>`;
      }
      const parent = r.parentSpan ? byId.get(r.parentSpan) : undefined;
      const relation = parent
        ? `<a href="#trace-${escape(parent.id)}">委託元・呼び出し元 #${parent.sequence}</a>`
        : "";
      const raw = `<details class="raw"><summary>詳細</summary><p>${escape(r.at)} → ${escape(end?.at ?? "終了未記録")}</p><p>記録番号：${r.sequence} · round ${r.round ?? "—"} · ${escape(r.callId ?? "")}</p><details><summary>${r.kind === "llm" ? "送信本文・内部共通形式（認証情報を除く）" : "入力の全文"}</summary><pre>${escape(JSON.stringify(r.kind === "llm" ? { ...input, body: output.body } : r.input, null, 2) ?? "未記録")}</pre></details><details><summary>${r.kind === "llm" ? "受信SSE・組み立てた応答（秘密値を除く）" : "出力の全文"}</summary><pre>${escape(JSON.stringify(end?.output, null, 2) ?? "未記録")}</pre></details></details>`;
      return `<article id="trace-${escape(r.id)}" class="receipt-card ${isLlm ? "model" : "harness"}"><header class="receipt-heading"><h3>#${index + 1} · ${escape(title)}</h3><span class="badge">${isLlm ? (r.simulated ? "LLM模擬" : "LLM") : "ハーネス"}</span></header><div class="receipt-process"><h4>処理</h4><p>${escape(end?.status ?? "終了未記録")} · エージェント ${escape(r.agentId)} · 周回 ${r.round ?? "—"}</p>${relation}</div><div class="exchange"><div><h4>入力</h4>${inputView}</div><div><h4>出力</h4>${outputView}</div></div>${raw}</article>`;
    })
    .join("\n");
  return `<section><h2>全体の実行経過</h2><p>${starts.length} 件 · 不正記録の除外 ${replay.skipped} 件。表示番号は開始順です。STEP番号・既存レシート番号とは別です。</p><p>親と子の処理を開始順で表示します。並列処理は時間が重なります。終了記録のない処理も表示します。対象なしは実行結果で、未実行のSTEPは作りません。</p>${starts.some((r) => r.simulated) ? '<p class="note">この記録にはFakeProviderの模擬呼び出しが含まれます。模擬呼び出しは実APIへ送信していません。</p>' : ""}${cards}</section>`;
}
