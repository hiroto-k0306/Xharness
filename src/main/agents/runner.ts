import { randomUUID } from "node:crypto";
import { join, relative, isAbsolute } from "node:path";
import { resolveModel } from "../config/config.js";
import { loadModelCatalog } from "../config/model-catalog.js";
import { runTurn, type LoopOptions } from "../core/loop.js";
import { type ProviderId } from "../core/types.js";
import { Router } from "../core/router.js";
import { FileAccess } from "../tools/files.js";
import { type ToolCall, type ToolRegistry } from "../tools/registry.js";
import { SessionStore, usedProviders, gitInfo } from "../session/store.js";
import { ReceiptStore } from "../session/receipts.js";
import { type AgentDefinition } from "./definitions.js";
import { loadProjectConfig, projectMemory } from "../config/project.js";
import { prepareHistory, estimateTokens } from "../context/compactor.js";
import { type StepHook } from "../core/loop-types.js";

export interface ChildContext {
  branch?: string;
  id: string;
  name: string;
  cwd: string;
  files?: string[];
}
export interface ChildOptions {
  onTranscript?(
    context: ChildContext,
    messages: import("../core/types.js").Message[],
  ): void;
  hooks?(
    context: ChildContext,
    onReceipt: (receipt: import("../core/loop-types.js").Receipt) => void,
  ): { beforeStep: StepHook; afterStep: StepHook };
  home: string;
  parentId: string;
  router: Router;
  aliases?: Record<string, string>;
  createTools(cwd: string): ToolRegistry;
  permission(
    call: ToolCall,
    context: ChildContext,
    signal: AbortSignal,
  ): Promise<boolean>;
  onEvent?(
    context: ChildContext,
    event: Parameters<NonNullable<LoopOptions["onEvent"]>>[0],
  ): void;
  onStatus?(
    context: ChildContext,
    model: string,
    status: "running" | "done" | "error",
  ): void;
  redact?(text: string): string;
}
export class ChildRunner {
  constructor(private readonly options: ChildOptions) {
    if (!/^[\w-]+$/.test(options.parentId))
      throw new Error("Invalid parent session id");
  }
  async run(
    name: string,
    definition: AgentDefinition,
    prompt: string,
    cwd: string,
    signal: AbortSignal,
    worker?: { files: string[]; reportTool: ToolRegistry },
  ) {
    signal.throwIfAborted();
    const choice = resolveModel(definition.model, this.options.aliases);
    const model =
      choice &&
      loadModelCatalog().find(
        (m) =>
          m.enabled && m.id === choice.model && m.provider === choice.provider,
      );
    if (
      !choice ||
      !model ||
      (definition.effort && model.efforts && !model.efforts[definition.effort])
    )
      throw new Error("Unavailable agent model or effort");
    const context: ChildContext = {
      id: randomUUID(),
      name,
      cwd,
      files: worker?.files,
      branch: (await gitInfo(cwd)).branch,
    };
    const clean = this.options.redact ?? ((text: string) => text);
    const home = join(this.options.home, "agents", this.options.parentId);
    const store = new SessionStore(home);
    const receipts = new ReceiptStore(home);
    await store.load();
    await store.save({
      id: context.id,
      title: name,
      workspaceId: null,
      cwd,
      model: choice.model,
      effort: definition.effort ?? "high",
      readOnly: !worker,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      providers: [choice.provider],
    });
    const available = this.options.createTools(cwd);
    const tools: ToolRegistry = new Map();
    const access = new FileAccess(cwd);
    for (const name of definition.tools) {
      const tool = available.get(name);
      if (
        !tool ||
        name === "Task" ||
        (!worker && ["Write", "Edit"].includes(name))
      )
        continue;
      tools.set(name, {
        ...tool,
        async validate(input) {
          if (worker && worker.reportTool.size === 0)
            return "Worker already reported completion";
          const error = await tool.validate(input);
          if (error) return error;
          if (worker && ["Write", "Edit"].includes(name)) {
            const path = await access.path(
              String((input as { path?: unknown }).path),
            );
            const rel = relative(await access.path("."), path);
            if (rel.startsWith("..") || isAbsolute(rel))
              return "Worker writes must stay in its workspace";
          }
          if (!worker && name === "Bash") {
            const command = String((input as { command?: unknown }).command);
            if (
              /[;|&>\r\n$`]/.test(command) ||
              !/^(?:(?:pnpm|npm) (?:test|run (?:test|lint|typecheck|build))|(?:npx )?vitest(?: run)?|pytest)(?:\s|$)/.test(
                command,
              )
            )
              return "Reviewer Bash is limited to test commands";
          }
        },
      });
    }
    for (const [name, tool] of worker?.reportTool ?? []) tools.set(name, tool);
    let sequence = 0;
    const writes: Promise<void>[] = [];
    this.options.onStatus?.(context, choice.model, "running");
    try {
      const project = await loadProjectConfig(this.options.home, cwd);
      const system = `You are ${name}. Work in ${cwd}. You have no parent conversation history. Never launch child agents. ${worker ? "Stay inside your workspace. ReportDone is required." : "Read-only investigation/review. Do not modify files. Return only your final report."}\nProject instructions:\n${clean(await projectMemory(this.options.home, cwd, project.context.memoryFiles))}`;
      const hooks = this.options.hooks?.(context, (r) => {
        const write = receipts.append(
          context.id,
          [
            {
              id: `#${++sequence}`,
              sessionId: context.id,
              ts: Date.parse(r.completedAt),
              provider: "hook",
              kind: "hook",
              tool: r.tool,
              model: r.model,
              input: r.input,
              output: r.output,
              durationMs: Date.parse(r.completedAt) - Date.parse(r.startedAt),
              summary: `hook ${r.timing}:${r.step} → ${r.tool} ${r.decision}`,
            },
          ],
          clean,
        );
        void write.catch(() => undefined);
        writes.push(write);
        this.options.onEvent?.(context, { type: "receipt", receipt: r });
      });
      const result = await runTurn(
        {
          provider: this.options.router.provider(choice.model),
          router: this.options.router,
          onFallback: (route) =>
            this.options.onStatus?.(context, route.model, "running"),
          model: choice.model,
          sessionId: context.id,
          reasoning: definition.effort
            ? { effort: definition.effort }
            : undefined,
          system,
          prepareContext: async (messages, route) => {
            const prepared = prepareHistory(messages, {
              limit: route.provider.models().find((m) => m.id === route.model)
                ?.contextTokens,
              overhead:
                estimateTokens({
                  system,
                  tools: [...tools.values()].map((t) => t.spec),
                }) + 4096,
              threshold: project.context.compactThreshold,
            });
            return {
              messages: prepared.messages,
              ...(!prepared.fits ? { stop: "context_overflow" } : {}),
            };
          },
          messages: [
            { role: "user", content: [{ type: "text", text: clean(prompt) }] },
          ],
          tools,
          permission: (call, signal) =>
            this.options.permission(call, context, signal),
          redact: clean,
          beforeStep: hooks?.beforeStep,
          afterStep: async (step, ctx, signal) => {
            const result = await hooks?.afterStep(step, ctx, signal);
            if (
              worker &&
              worker.reportTool.size === 0 &&
              result?.kind === "inject"
            )
              return { kind: "stop", reason: "hook_failed" };
            if (result && result.kind !== "continue") return result;
            return worker && step === "receipt" && worker.reportTool.size === 0
              ? { kind: "stop", reason: "reported_done" }
              : { kind: "continue" };
          },
          onEvent: (event) => {
            if (event.type === "receipt") {
              const r = event.receipt;
              const write = receipts.append(
                context.id,
                [
                  {
                    id: `#${++sequence}`,
                    sessionId: context.id,
                    ts: Date.parse(r.completedAt),
                    provider:
                      r.provider === "tool"
                        ? "harness"
                        : (r.provider as ProviderId),
                    model: r.model,
                    kind:
                      r.provider === "hook"
                        ? "hook"
                        : r.tool
                          ? "tool"
                          : "model_call",
                    tool: r.tool,
                    durationMs:
                      Date.parse(r.completedAt) - Date.parse(r.startedAt),
                    summary: `${r.tool ?? r.model}: ${r.decision}`,
                    input: r.input,
                    output: r.output,
                  },
                ],
                clean,
              );
              void write.catch(() => undefined);
              writes.push(write);
            }
            this.options.onEvent?.(context, event);
          },
        },
        signal,
      );
      await Promise.all(writes);
      await store.append(context.id, result.messages, clean);
      this.options.onTranscript?.(context, result.messages);
      if (!["end_turn", "reported_done"].includes(result.stopCause))
        throw new Error(`Agent stopped: ${result.stopCause}`);
      const final = result.messages
        .filter((m) => m.role === "assistant")
        .at(-1);
      const actual = result.receipts.findLast(
        (r) => r.provider === "claude" || r.provider === "codex",
      );
      const saved = store.get(context.id)!;
      await store.save({
        ...saved,
        model: actual?.model ?? choice.model,
        updatedAt: Date.now(),
        providers: usedProviders(result.messages, saved.providers),
      });
      this.options.onStatus?.(context, actual?.model ?? choice.model, "done");
      return {
        text: clean(
          final?.content
            .flatMap((b) => (b.type === "text" ? [b.text] : []))
            .join("\n") ?? "",
        ),
        context,
        provider: (actual?.provider ?? choice.provider) as ProviderId,
        model: actual?.model ?? choice.model,
      };
    } catch (error) {
      await Promise.allSettled(writes);
      this.options.onStatus?.(context, choice.model, "error");
      throw error;
    }
  }
}
