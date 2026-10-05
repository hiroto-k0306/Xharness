import {
  readTraceReplay,
  renderTraceReplay,
  type TraceReplay,
} from "./report-trace.js";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ReceiptReplay } from "../../shared/replay.js";
import { imageMetadata } from "../../shared/images.js";
import { readReceiptReplay } from "./replay.js";
import {
  initialRequest,
  requestView,
  responseView,
  toolName,
  receiptInputView,
  receiptOutputView,
  recordedStatus,
} from "./report-readable.js";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const LIMIT = 32_000_000;

/** Export-only masking. Opaque provider blocks in the original history stay intact. */
function sanitize(value: unknown, clean: (text: string) => string): string {
  return clean(
    JSON.stringify(value, (key, v: unknown) => {
      const image = imageMetadata(v);
      if (image !== v) return image;
      if (
        /^(?:authorization|chatgpt-account-id|account_?id|access_?token|refresh_?token|password|secret|signature|encrypted_content|opaque)$/i.test(
          key,
        )
      )
        return "[redacted]";
      if (typeof v !== "string") return v;
      try {
        const nested: unknown = JSON.parse(v);
        if (nested && typeof nested === "object")
          return sanitize(nested, clean);
      } catch {
        /* Ordinary prose is not JSON. */
      }
      return clean(v);
    }) ?? "null",
  )
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      "[redacted]",
    );
}

async function history(
  base: string,
  id: string,
  clean: (text: string) => string,
) {
  const path = join(base, "sessions", `${id}.jsonl`);
  try {
    if ((await stat(path)).size > 16_000_000)
      throw new Error("Report history exceeds size limit");
    const raw = await readFile(path, "utf8");
    const messages: unknown[] = [];
    let skipped = 0;
    for (const line of raw.split(/\r?\n/).filter((s) => s.trim())) {
      if (messages.length + skipped >= 10000)
        throw new Error("Too many report messages");
      try {
        const m = JSON.parse(line) as { role?: unknown; content?: unknown };
        if (
          !m ||
          !["user", "assistant", "system"].includes(String(m.role)) ||
          !Array.isArray(m.content)
        )
          throw new Error();
        messages.push(JSON.parse(sanitize(m, clean)));
      } catch {
        skipped++;
      }
    }
    return { messages, skipped };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { messages: [], skipped: 0 };
    throw new Error("Report history could not be read");
  }
}

export interface ReportAgent {
  id: string;
  parentId?: string;
  replay: ReceiptReplay;
  messages: unknown[];
  skippedMessages: number;
  trace?: TraceReplay;
}

/** Read-only snapshot: no model, tools, session initialization or replay execution. */
export async function readExecutionReport(
  home: string,
  id: string,
  clean: (text: string) => string = (s) => s,
) {
  if (!/^[\w-]{1,512}$/.test(id)) throw new Error("Invalid report session id");
  const agents: ReportAgent[] = [];
  let size = 0;
  const add = async (agentId: string, parentId?: string) => {
    const base = parentId ? join(home, "agents", parentId) : home;
    const replay = await readReceiptReplay(home, agentId, { parentId, clean });
    const saved = await history(base, agentId, clean);
    const agent: ReportAgent = {
      id: agentId,
      parentId,
      replay,
      messages: saved.messages,
      skippedMessages: saved.skipped,
      trace: parentId ? undefined : await readTraceReplay(home, agentId, clean),
    };
    size += JSON.stringify(agent).length;
    if (size > LIMIT) throw new Error("Report exceeds size limit");
    agents.push(agent);
  };
  await add(id);
  const children = new Set<string>();
  for (const dir of ["receipts", "sessions"]) {
    let entries: string[];
    try {
      entries = await readdir(join(home, "agents", id, dir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Report agents could not be read");
    }
    for (const file of entries) {
      const match = /^([\w-]{1,512})\.jsonl$/.exec(file);
      if (match) children.add(match[1]!);
    }
  }
  if (children.size > 100) throw new Error("Too many report agents");
  for (const child of [...children].sort()) await add(child, id);
  return agents;
}

const payload = (label: string, value: unknown) =>
  value === undefined
    ? `<p>${escape(label)}：未記録</p>`
    : `<details><summary>${escape(label)}</summary><pre>${escape(JSON.stringify(value, null, 2))}</pre></details>`;

export function renderExecutionReport(
  agents: ReportAgent[],
  clean: (text: string) => string = (s) => s,
): string {
  // Sanitize again at the rendering boundary, including JSON stored inside output strings.
  const safe = agents.map((a) => JSON.parse(sanitize(a, clean)) as ReportAgent);
  const root = safe[0]?.id ?? "unknown";
  const trace = safe[0]?.trace;
  const sections = safe
    .map((a, index) => {
      let previousRequest: unknown;
      const cards = a.replay.frames
        .map((f) => {
          const r = f.receipt;
          let output: unknown = r.output;
          if (typeof output === "string") {
            try {
              output = JSON.parse(sanitize(JSON.parse(output), clean));
            } catch {
              /* plain tool output */
            }
          }
          const stage =
            r.kind === "model_call"
              ? "STEP 2 · モデル呼び出しの記録"
              : r.kind === "tool"
                ? "STEP 3–5 · 検証・権限・ツール実行の結果"
                : r.kind === "permission"
                  ? "STEP 4 · 権限"
                  : r.kind === "compact"
                    ? "圧縮"
                    : r.kind === "hook"
                      ? "フック"
                      : r.kind === "auth_refresh"
                        ? "公式CLIによる認証更新"
                        : "モデル切替";
          const isModel =
            r.kind === "model_call" &&
            (r.provider === "claude" || r.provider === "codex");
          const inputView = isModel
            ? requestView(r.input, previousRequest)
            : receiptInputView(r.input);
          const outputView =
            isModel && output !== undefined
              ? responseView(output)
              : receiptOutputView(output);
          if (isModel) previousRequest = r.input;
          const title =
            r.kind === "model_call"
              ? "LLMへの依頼と応答"
              : r.kind === "tool"
                ? toolName(r.tool ?? "ツール実行")
                : stage;
          const status = recordedStatus(r.summary, r.decision);
          return `<article class="receipt-card ${isModel ? "model" : "harness"}"><details class="receipt-collapse"><summary class="receipt-heading"><h3>${escape(r.id)} · ${escape(title)}</h3><span class="badge">${isModel ? "LLM" : "ハーネス"}</span></summary><div class="receipt-body"><div class="receipt-process"><h4>処理</h4><p class="meta">${stage} · ${escape(isModel ? (r.model ?? r.provider) : r.provider === "hook" ? "フック" : "ハーネス")}</p>${status ? `<p>${escape(status)}</p>` : `<p>${escape(r.summary)}</p>`}</div><div class="exchange"><div><h4>入力</h4>${inputView}</div><div><h4>出力</h4>${outputView}</div></div><details class="raw"><summary>詳細</summary><p>${escape(f.recordedAt)} · ${r.durationMs} ms${r.usage ? ` · 入力 ${r.usage.inputTokens} / 出力 ${r.usage.outputTokens} tokens` : ""}</p><p>${escape(r.summary)}${r.decision ? ` · ${escape(r.decision)}` : ""}</p>${payload(r.kind === "model_call" ? "LLM入力（内部共通形式：system・履歴・ツール定義）" : "入力・委託内容", r.input)}${payload(r.kind === "model_call" ? "LLM応答（内部共通形式）" : "出力・返却結果", output)}</details></div></details></article>`;
        })
        .join("\n");
      return `<section id="agent-${index}"><h2>${index === 0 ? "親セッション" : "子エージェント"} · ${escape(a.id)}</h2>${a.parentId ? `<p>親：${escape(a.parentId)} → 子：${escape(a.id)}。${trace ? "対応は実行経過の委託元リンクで確認できます。" : "個々の Task と子 ID の対応は未記録です。"}</p>` : ""}<p>記録 ${a.replay.frames.length} 件 · 不正な記録の除外 ${a.replay.skipped + a.skippedMessages} 件</p>${initialRequest(
        a.messages,
        a.replay.frames
          .filter((f) => f.receipt.kind === "model_call")
          .map((f) => f.receipt.input),
      )}${payload("保存会話の全体（詳細JSON）", a.messages)}${cards || "<p>レシートはありません。</p>"}</section>`;
    })
    .join("\n");
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>XHarness 実行レポート</title><style>
body{margin:0;background:#10151f;color:#e5eaf2;font:15px/1.7 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:32px}h1,h2,h3{line-height:1.4}h2{margin-top:44px}a{color:#99c9ff}nav{display:flex;gap:16px;flex-wrap:wrap}article{border:1px solid #354052;border-left:4px solid #7892ac;border-radius:8px;margin:16px 0;padding:18px}.model{border-left-color:#ab9bff}details{background:#192231;border-radius:5px;margin:10px 0;padding:10px}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 monospace}.meta,.note{color:#bac7d8}.steps{padding:14px;background:#192231}@media print{body{background:white;color:black}details, .steps{background:#eee}article{break-inside:avoid}.meta,.note{color:#444}}@media(max-width:600px){main{padding:16px}}
 h4{margin:12px 0 6px;font-size:14px}.exchange{display:grid;grid-template-columns:1fr 1fr;gap:20px}.exchange>div{min-width:0}.readable-block pre{font:14px/1.7 system-ui,sans-serif;margin:0}.readable-block,.initial-request{padding:12px;background:#192231;border-radius:6px;margin:8px 0}.tool-request,.tool-result{border-left:2px solid #829ac2;padding-left:12px}.raw{margin-top:20px}article+article::before{content:'↓ 次の保存記録';display:block;color:#bac7d8;margin-bottom:12px}@media(max-width:760px){.exchange{grid-template-columns:1fr}}@media print{.readable-block,.initial-request{background:#eee}}
 .receipt-card{border-left-color:#354052;background:#141b26}.receipt-card.model{border-left-color:#ab9bff;background:#221f34}.receipt-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.receipt-heading h3{margin:0}.badge{border:1px solid #566176;border-radius:20px;padding:2px 10px;white-space:nowrap;font-size:12px}.model .badge{border-color:#ab9bff;color:#d3c9ff}.model .readable-block,.model details{background:#2b2741}.legend{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.legend .llm{border-left:4px solid #ab9bff;padding:4px 10px;background:#221f34}@media print{.receipt-card{background:white}.receipt-card.model{background:#f2efff}.model .readable-block,.model details{background:#eae6fa}.model .badge{color:#49317c}}
 .receipt-collapse{margin:0;padding:0;background:transparent!important}.receipt-collapse>summary{cursor:pointer;list-style:none}.receipt-collapse>summary::-webkit-details-marker{display:none}.receipt-collapse>summary::before{content:"▸";color:#bac7d8}.receipt-collapse[open]>summary::before{content:"▾"}.receipt-heading h3{flex:1}.report-overview{padding:14px;background:#192231;border-radius:6px}.receipt-body{padding-top:10px}
</style></head><body><main><h1>XHarness 実行レポート</h1><p>セッション：${escape(root)} · 出力日時：${new Date().toISOString()}</p><p class="steps">1 context：入力構築 → 2 model：LLM → 3 tool_use：検証 → 4 gate：権限 → 5 act：実行・委託 → 6 receipt：記録</p><p class="legend"><span class="llm">紫：LLMのモデル呼び出し記録</span><span>通常色：ハーネスの処理</span></p><p class="note">すべての記録を「処理・入力・出力・詳細」の同じ形式で表示しています。各 # の見出しで個別に開閉できます。本文は原文のままです。全文は各項目の詳細JSONで確認できます。</p>${trace ? '<details><summary>記録の範囲と表示方法</summary><p class="note">実行トレースは実測の開始・終了と結果を表示します。LLMの簡易入力は内部共通形式です。詳細にはfetchに渡した送信JSONとデコード前の受信SSE（event/data）を保存しています。認証ヘッダ、HTTPエラー本文、SSEのコメント・改行形式・未解析の断片は保存しません。秘密値・暗号化reasoning・署名は伏せています。模擬呼び出しに実際の送信本文はありません。容量上限による省略は明示します。補足の従来レシートは保存順で、記載時間は通信単独の時間とは限りません。導入前の処理や未記録の処理は復元しません。</p></details>' : `<details><summary>記録の範囲と表示方法</summary><p class="note">${trace ? "実行トレースは開始・終了時刻と実行結果を記録します。LLM詳細には認証情報を除いた変換後の送信本文と受信SSEがあります。保存上限による省略は明示します。" : "保存済みデータの表示です。STEP説明は設計上の役割で、STEPごとの実測時系列ではありません。"}各エージェント内はレシートの保存順です。時刻・所要時間は保存値であり、通信開始時刻や通信単独の時間とは限りません。入力は API 変換前の内部共通形式、応答は組み立て後の内部共通形式です。${trace ? "下記の従来レシートは内部共通形式です。トレース導入前の処理や、受信を中断した後のデータは未記録です。" : "HTTP本文・生のSSE・再試行ごとの通信・補助LLM通信は網羅していません。"}圧縮やWeb要約、子の実行中にもLLM通信が発生し得ます。未記録の処理は復元しません。暗号化reasoningと署名は伏せています。</p></details>`}<nav>${safe.map((a, i) => `<a href="#agent-${i}">${i === 0 ? "親" : "子"} ${escape(a.id)}</a>`).join("")}</nav>${trace ? renderTraceReplay(trace, root) + `<details><summary>保存会話と従来のレシート</summary>${sections}</details>` : sections}</main></body></html>`;
  if (html.length > LIMIT * 6)
    throw new Error("Report HTML exceeds size limit");
  return html;
}

export async function exportExecutionReport(
  home: string,
  id: string,
  path: string,
  clean: (text: string) => string = (s) => s,
) {
  const html = renderExecutionReport(
    await readExecutionReport(home, id, clean),
    clean,
  );
  // Never overwrite an existing report or any source record (CLI callers get EEXIST).
  await writeFile(path, html, { encoding: "utf8", flag: "wx" });
}
