import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  historyText,
  projectHistoryAccess,
  type HistoryScope,
} from "../tools/project-history.js";
import {
  type MemorySourceInput,
  type MemorySource,
} from "../../shared/project-memory.js";
import { type Receipt } from "../../shared/ipc.js";

export const memoryHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
export function memoryScope(scope: HistoryScope) {
  const access = projectHistoryAccess(scope);
  const identity = async () => {
    const pin = await access.pin;
    if (
      !pin ||
      !(await scope.sessions.ownsHome(pin.home)) ||
      !(await access.eligible(scope.sessions.get(scope.sessionId), true))
    )
      throw new Error("Project memory unavailable in this project/home");
    const canonical = (p?: string) =>
      process.platform === "win32" ? p?.toLowerCase() : p;
    return {
      ...pin,
      key: memoryHash({ root: canonical(pin.root), git: canonical(pin.git) }),
    };
  };
  const source = async (input: MemorySourceInput): Promise<MemorySource> => {
    const pin = await identity();
    const session = scope.sessions.get(input.sessionId);
    if (!(await access.eligible(session, true)) || !session)
      throw new Error("Source unavailable in this project");
    const history = await scope.sessions.historyRecords(
      input.sessionId,
      pin.home,
    );
    const record = history?.records.find((r) => r.line === input.messageLine);
    if (
      !history ||
      history.truncated ||
      !record ||
      !["user", "assistant"].includes(record.message.role)
    )
      throw new Error("Source message unavailable or bounded");
    const text = historyText(
      record.message.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("\n"),
      scope.clean,
    );
    if (
      !text.trim() ||
      !text.replaceAll("[credential-like line omitted]", "").trim()
    )
      throw new Error("No ordinary source text");
    let evidence: MemorySource["evidence"] =
      record.message.role === "assistant" ? "model_claim" : "user_statement";
    let tool: string | undefined,
      result: MemorySource["result"],
      resultHash: string | undefined;
    if (input.receiptId) {
      const directory = join(pin.home, "receipts"),
        path = join(directory, `${session.id}.jsonl`);
      if (
        !same(await realpath(directory), directory) ||
        !same(await realpath(path), path) ||
        (await stat(path)).size > 1048576
      )
        throw new Error("Receipt unavailable or bounded");
      const rows = (await readFile(path, "utf8"))
        .split("\n")
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Receipt];
          } catch {
            return [];
          }
        });
      const receipt = rows.findLast(
        (r) =>
          r.sessionId === session.id &&
          r.id === input.receiptId &&
          r.kind === "tool" &&
          typeof r.tool === "string" &&
          typeof r.output === "string",
      );
      if (!receipt)
        throw new Error(
          "Executed tool receipt required; model assertions are not test evidence",
        );
      evidence = "tool_result";
      tool = historyText(receipt.tool!, scope.clean).slice(0, 100);
      result = receipt.error ? "error" : "completed";
      resultHash = memoryHash(receipt);
      if (!same(await realpath(path), path)) throw new Error("Receipt changed");
    }
    if (!(await access.eligible(scope.sessions.get(session.id), true)))
      throw new Error("Source changed");
    return {
      ...input,
      sessionCreatedAt: new Date(session.createdAt).toISOString(),
      sessionUpdatedAt: new Date(session.updatedAt).toISOString(),
      messageHash: memoryHash(text),
      role: record.message.role,
      evidence,
      tool,
      result,
      resultHash,
    };
  };
  return { identity, source };
}
