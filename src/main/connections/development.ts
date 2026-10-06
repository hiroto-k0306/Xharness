import { randomUUID } from "node:crypto";
import { acquireHomeWriter } from "../home-writer.js";
import { SessionStore } from "../session/store.js";
import { ReceiptStore } from "../session/receipts.js";
import { toReceipt } from "../session/context.js";
import { withSessionCalls } from "../session/llm-calls.js";
import { withSessionTrace, withTaskTrace } from "../core/trace.js";
import { redact } from "../core/redact.js";
import {
  runConnectedTurnOwned,
  type ConnectionSelection,
} from "./integration.js";
import type { LoopOptions } from "../core/loop.js";

/** Fresh development session only; never resumes a partially committed history automatically. */
export async function runDevelopmentConnection(
  home: string,
  cwd: string,
  prompt: string,
  selection: Omit<ConnectionSelection, "taskId">,
  options: Pick<LoopOptions, "tools" | "permission" | "model">,
  abort: AbortController,
) {
  const writer = await acquireHomeWriter(home);
  const sessions = new SessionStore(home);
  const receipts = new ReceiptStore(home);
  const id = randomUUID(),
    taskId = randomUUID();
  // Do not read CLI credential files to construct redaction secrets.
  const clean = (value: string) => redact(value, []);
  try {
    await sessions.load();
    await sessions.save({
      id,
      title: `connection:${selection.mode}`,
      workspaceId: null,
      cwd,
      readOnly: true,
      model: options.model,
      effort: "low",
      permissionMode: "default",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      providers: [],
    });
    const user = {
      role: "user" as const,
      content: [{ type: "text" as const, text: prompt }],
    };
    await sessions.append(id, [user], clean);
    await sessions.recordEvaluationTask(id, taskId, true, false);
    const collected: Parameters<typeof toReceipt>[0][] = [];
    const result = await withSessionCalls(
      {
        home,
        id,
        limits: { llmCallsPerTurn: 4, llmCallsPerSession: 4 },
        abort,
      },
      () =>
        withSessionTrace(home, id, clean, () =>
          withTaskTrace({ model: options.model, taskId }, () =>
            runConnectedTurnOwned(
              home,
              {
                ...options,
                permission: async (call, signal) =>
                  options.tools.get(call.name)?.readOnly === true &&
                  (await options.permission(call, signal)),
                provider: {
                  id: "claude",
                  models: () => [],
                  stream() {
                    throw new Error("Legacy provider must not be used");
                  },
                },
                sessionId: id,
                system: "Use only the explicitly supplied X tools.",
                messages: [user],
                maxRounds: 4,
                redact: clean,
                onEvent: (event) => {
                  if (event.type === "receipt") collected.push(event.receipt);
                },
              },
              { ...selection, taskId },
              abort.signal,
            ),
          ),
        ),
    );
    await receipts.append(
      id,
      [
        ...result.receipts,
        ...collected.filter((r) => !result.receipts.includes(r)),
      ].map((r) => toReceipt(r, id, randomUUID())),
      clean,
    );
    await sessions.append(id, result.messages.slice(1), clean);
    await sessions.recordEvaluationTask(
      id,
      taskId,
      result.stopCause !== "end_turn",
      true,
    );
    return { sessionId: id, taskId, ...result };
  } finally {
    await writer.release();
  }
}
