import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ReceiptReplay } from "../../shared/replay.js";
import { readReceiptReplay } from "./replay.js";
import {
  initialRequest,
  requestView,
  responseView,
  toolName,
  toolView,
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
                      : "モデル切替";
          const readable =
            r.kind === "model_call"
              ? `<div class="exchange"><div><h4>LLMに渡した内容</h4>${requestView(r.input, previousRequest)}</div><div><h4>LLMから返った内容</h4>${output === undefined ? "<p>応答は未記録です。</p>" : responseView(output)}</div></div>`
              : r.kind === "tool"
                ? toolView(r.tool ?? "ツール", r.input, output)
                : `<p>${escape(r.summary)}${r.decision ? ` · ${escape(r.decision)}` : ""}</p>`;
          if (r.kind === "model_call") previousRequest = r.input;
          const title =
            r.kind === "model_call"
              ? "LLMへの依頼と応答"
              : r.kind === "tool"
                ? toolName(r.tool ?? "ツール実行")
                : stage;
          return `<article class="${r.kind === "model_call" ? "model" : "harness"}"><h3>${escape(r.id)} · ${escape(title)}</h3><p class="meta">${stage} · ${escape(r.model ?? r.provider)}</p><p>${escape(recordedStatus(r.summary, r.decision))}</p>${readable}<details class="raw"><summary>詳細JSON・記録情報を確認</summary><p>${escape(f.recordedAt)} · ${r.durationMs} ms${r.usage ? ` · 入力 ${r.usage.inputTokens} / 出力 ${r.usage.outputTokens} tokens` : ""}</p><p>${escape(r.summary)}${r.decision ? ` · ${escape(r.decision)}` : ""}</p>${payload(r.kind === "model_call" ? "LLM入力（内部共通形式：system・履歴・ツール定義）" : "入力・委託内容", r.input)}${payload(r.kind === "model_call" ? "LLM応答（内部共通形式）" : "出力・返却結果", output)}</details></article>`;
        })
        .join("\n");
      return `<section id="agent-${index}"><h2>${index === 0 ? "親セッション" : "子エージェント"} · ${escape(a.id)}</h2>${a.parentId ? `<p>親：${escape(a.parentId)} → 子：${escape(a.id)}。個々の Task と子 ID の対応は未記録です。</p>` : ""}<p>記録 ${a.replay.frames.length} 件 · 不正な記録の除外 ${a.replay.skipped + a.skippedMessages} 件</p>${initialRequest(
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
</style></head><body><main><h1>XHarness 実行レポート</h1><p>セッション：${escape(root)} · 出力日時：${new Date().toISOString()}</p><p class="steps">1 context：入力構築 → 2 model：LLM → 3 tool_use：検証 → 4 gate：権限 → 5 act：実行・委託 → 6 receipt：記録</p><p class="note">依頼・LLMの返答・ツール結果を簡易表示しています。本文は原文のままです。全文は各項目の詳細JSONで確認できます。</p><details><summary>記録の範囲と表示方法</summary><p class="note">保存済みデータの表示です。STEP説明は設計上の役割で、STEPごとの実測時系列ではありません。各エージェント内はレシートの保存順です。時刻・所要時間は保存値であり、通信開始時刻や通信単独の時間とは限りません。入力は API 変換前の内部共通形式、応答は組み立て後の内部共通形式です。HTTP本文・生のSSE・再試行ごとの通信・補助LLM通信は網羅していません。圧縮やWeb要約、子の実行中にもLLM通信が発生し得ます。未記録の処理は復元しません。暗号化reasoningと署名は伏せています。</p></details><nav>${safe.map((a, i) => `<a href="#agent-${i}">${i === 0 ? "親" : "子"} ${escape(a.id)}</a>`).join("")}</nav>${sections}</main></body></html>`;
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
