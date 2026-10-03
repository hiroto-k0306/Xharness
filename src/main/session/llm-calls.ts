import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  LlmBudget,
  withLlmBudget,
  LlmBudgetError,
} from "../core/llm-budget.js";
import {
  type LlmCalls,
  type LlmLimits,
  validLlmCalls,
  unlimitedCalls,
} from "../../shared/llm-calls.js";
import { JsonFile } from "./store.js";

function path(home: string, id: string) {
  if (!/^[\w-]+$/.test(id)) throw new LlmBudgetError("budget_storage_failed");
  return join(home, "sessions", id + ".llm-calls.json");
}
export async function readLlmCalls(
  home: string,
  id: string,
): Promise<LlmCalls> {
  try {
    const value: unknown = JSON.parse(await readFile(path(home, id), "utf8"));
    if (!validLlmCalls(value)) throw new Error();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new LlmBudgetError("budget_storage_failed");
    return {
      ...unlimitedCalls,
      turn: 0,
      session: 0,
      simulatedTurn: 0,
      simulatedSession: 0,
      since: Date.now(),
    };
  }
}
const activeSessions = new Set<string>();
export async function withSessionCalls<T>(
  options: Parameters<typeof runSessionCalls<T>>[0],
  run: (budget: LlmBudget) => Promise<T>,
): Promise<T> {
  const absolute = resolve(path(options.home, options.id));
  const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  if (activeSessions.has(key)) throw new LlmBudgetError("budget_busy");
  activeSessions.add(key);
  try {
    options.abort.signal.throwIfAborted();
    return await runSessionCalls(options, run);
  } finally {
    activeSessions.delete(key);
  }
}
async function runSessionCalls<T>(
  options: {
    home: string;
    id: string;
    limits: LlmLimits;
    abort: AbortController;
    changed?: (calls: LlmCalls) => void;
  },
  run: (budget: LlmBudget) => Promise<T>,
): Promise<T> {
  const calls = {
    ...(await readLlmCalls(options.home, options.id)),
    ...options.limits,
    turn: 0,
    simulatedTurn: 0,
  };
  const file = new JsonFile(path(options.home, options.id), validLlmCalls);
  // 保存先を送信前に検査し、通信がないターンの0件と設定変更も残す。
  try {
    await file.write(calls);
  } catch {
    throw new LlmBudgetError("budget_storage_failed");
  }
  const writes: Promise<void>[] = [];
  const budget = new LlmBudget(
    calls,
    options.abort,
    (snapshot) => {
      writes.push(file.write(snapshot).catch(() => budget.storageFailed()));
      options.changed?.(snapshot);
    },
    async () => {
      await Promise.all(writes);
    },
  );
  options.changed?.({ ...calls });
  try {
    const value = await withLlmBudget(budget, () => run(budget));
    await Promise.all(writes);
    if (budget.stopCause === "budget_storage_failed")
      throw new LlmBudgetError(budget.stopCause);
    return value;
  } catch (error) {
    if (budget.stopCause) throw new LlmBudgetError(budget.stopCause);
    throw error;
  } finally {
    budget.close();
    await Promise.all(writes);
  }
}
