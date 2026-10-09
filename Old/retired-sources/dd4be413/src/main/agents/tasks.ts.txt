import { randomUUID } from "node:crypto";
import { AgentStoppedError } from "./runner.js";
import { argumentsObject } from "../tools/files.js";
import { type Tool, type ToolRegistry } from "../tools/registry.js";

type Status = "running" | "done" | "stopped" | "error" | "awaiting_user";
interface Job {
  id: string;
  description: string;
  agent: string;
  status: Status;
  text?: string;
  abort: AbortController;
  done: Promise<void>;
}
export class AgentTasks {
  private jobs = new Map<string, Job>();
  beginTurn() {
    if ([...this.jobs.values()].some((j) => j.status === "running"))
      throw new Error("Child tasks are still running");
    this.jobs.clear();
  }
  constructor(
    private readonly run: (
      id: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<{ text: string }>,
  ) {}
  start(input: Record<string, unknown>, parent: AbortSignal) {
    parent.throwIfAborted();
    if (
      [...this.jobs.values()].filter((j) => j.status === "running").length >=
        3 ||
      this.jobs.size >= 32
    )
      throw new Error(
        "子タスクの上限です。同時実行は3件、作成は32件までです。",
      );
    const abort = new AbortController();
    const id = randomUUID();
    const job: Job = {
      id,
      description: String(input.description),
      agent: String(input.agent),
      status: "running",
      abort,
      done: Promise.resolve(),
    };
    const cancel = () => abort.abort();
    parent.addEventListener("abort", cancel, { once: true });
    this.jobs.set(id, job);
    job.done = Promise.resolve()
      .then(() => this.run(id, input, abort.signal))
      .then(
        (result) => {
          job.status = abort.signal.aborted ? "stopped" : "done";
          job.text = abort.signal.aborted
            ? "子タスクを停止しました。"
            : result.text;
        },
        (error) => {
          job.status = abort.signal.aborted
            ? "stopped"
            : error instanceof AgentStoppedError &&
                error.reason === "awaiting_user"
              ? "awaiting_user"
              : error instanceof AgentStoppedError
                ? "stopped"
                : "error";
          job.text =
            error instanceof AgentStoppedError
              ? error.message
              : job.status === "stopped"
                ? "子タスクを停止しました。"
                : "子タスクの実行に失敗しました。";
        },
      )
      .finally(() => parent.removeEventListener("abort", cancel));
    return JSON.stringify(this.view(job));
  }
  private view(j: Job) {
    return {
      taskId: j.id,
      description: j.description,
      agent: j.agent,
      status: j.status,
      result: j.text,
    };
  }
  async close() {
    for (const j of this.jobs.values())
      if (j.status === "running") j.abort.abort();
    await Promise.all([...this.jobs.values()].map((j) => j.done));
  }
  tools(): ToolRegistry {
    return new Map(
      ["TaskList", "TaskOutput", "TaskStop"].map<[string, Tool]>((name) => {
        const validate = async (input: unknown) => {
          try {
            const a = argumentsObject(input);
            const keys =
              name === "TaskList"
                ? []
                : name === "TaskOutput"
                  ? ["taskId", "wait", "timeoutSec"]
                  : ["taskId"];
            if (Object.keys(a).some((k) => !keys.includes(k)))
              return "Unknown argument";
            if (
              name !== "TaskList" &&
              (typeof a.taskId !== "string" || !this.jobs.has(a.taskId))
            )
              return "このセッションの子タスクが見つかりません。";
            if (a.wait !== undefined && typeof a.wait !== "boolean")
              return "wait must be boolean";
            if (
              a.timeoutSec !== undefined &&
              (!Number.isInteger(a.timeoutSec) ||
                Number(a.timeoutSec) < 1 ||
                Number(a.timeoutSec) > 60)
            )
              return "timeoutSec must be 1–60";
          } catch {
            return "Invalid arguments";
          }
        };
        return [
          name,
          {
            readOnly: true,
            spec: {
              name,
              description:
                name === "TaskList"
                  ? "List background child agents started by this parent turn."
                  : name === "TaskStop"
                    ? "Stop one background child agent, cancel its pending approvals and wait for cleanup. Does not stop the parent."
                    : "Get a background child agent status and result. Set wait=true to wait up to timeoutSec (default 30, maximum 60).",
              inputSchema: {
                type: "object",
                properties:
                  name === "TaskList"
                    ? {}
                    : {
                        taskId: { type: "string" },
                        ...(name === "TaskOutput"
                          ? {
                              wait: { type: "boolean" },
                              timeoutSec: {
                                type: "integer",
                                minimum: 1,
                                maximum: 60,
                              },
                            }
                          : {}),
                      },
                required: name === "TaskList" ? [] : ["taskId"],
                additionalProperties: false,
              },
            },
            validate,
            execute: async (input, signal) => {
              signal.throwIfAborted();
              const invalid = await validate(input);
              if (invalid) return { content: invalid, isError: true };
              const a = argumentsObject(input);
              if (name === "TaskList")
                return {
                  content: JSON.stringify(
                    [...this.jobs.values()].map((j) => this.view(j)),
                  ),
                };
              const job = this.jobs.get(String(a.taskId))!;
              if (name === "TaskStop") {
                if (job.status === "running") job.abort.abort();
                await job.done;
              } else if (a.wait && job.status === "running") {
                await new Promise<void>((resolve, reject) => {
                  const cleanup = () => {
                    clearTimeout(timer);
                    signal.removeEventListener("abort", cancel);
                  };
                  const done = () => {
                    cleanup();
                    resolve();
                  };
                  const cancel = () => {
                    cleanup();
                    reject(new Error("Interrupted"));
                  };
                  const timer = setTimeout(
                    done,
                    Number(a.timeoutSec ?? 30) * 1000,
                  );
                  signal.addEventListener("abort", cancel, { once: true });
                  void job.done.then(done);
                  if (signal.aborted) cancel();
                });
              }
              return { content: JSON.stringify(this.view(job)) };
            },
          },
        ];
      }),
    );
  }
}
