import { isAbsolute, matchesGlob, relative, resolve } from "node:path";
import { type HookResult } from "./step-hooks.js";
import {
  type StepHook,
  type StepName,
  type Receipt,
} from "../core/loop-types.js";
import { type Tool } from "../tools/registry.js";

export interface ShellHook {
  id: string;
  step: StepName;
  timing: "before" | "after";
  project: boolean;
  command?: string;
  timeoutSec: number;
  onFailure?: "inject" | "stop";
  onMatch?: "block";
  reason?: string;
  when?: {
    tools?: string[];
    agents?: string[];
    phases?: string[];
    pathGlob?: string;
  };
}
const steps = ["context", "model", "tool_use", "gate", "act", "receipt"];
export function parseShellHooks(
  values: unknown,
  project: boolean,
): ShellHook[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new Error("Hooks must be an array");
  return values.map((value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Invalid hook");
    const h = value as ShellHook;
    if (
      typeof h.id !== "string" ||
      !h.id.trim() ||
      !steps.includes(h.step) ||
      !["before", "after"].includes(h.timing) ||
      (h.onMatch !== undefined && h.onMatch !== "block") ||
      (h.onFailure !== undefined &&
        !["inject", "stop"].includes(h.onFailure)) ||
      (h.command !== undefined &&
        (typeof h.command !== "string" || !h.command.trim())) ||
      (h.onMatch === "block" &&
        (h.timing !== "before" ||
          typeof h.reason !== "string" ||
          !h.reason.trim())) ||
      (!h.command && h.onMatch !== "block")
    )
      throw new Error("Invalid shell hook");
    const timeoutSec = h.timeoutSec ?? 60;
    if (!Number.isSafeInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 600)
      throw new Error("Invalid hook timeout");
    if (h.when !== undefined) {
      if (
        !h.when ||
        typeof h.when !== "object" ||
        ["tools", "agents", "phases"].some((k) => {
          const v = h.when![k as "tools"];
          return (
            v !== undefined &&
            (!Array.isArray(v) ||
              !v.length ||
              v.some((s) => typeof s !== "string" || !s))
          );
        }) ||
        (h.when.pathGlob !== undefined &&
          (typeof h.when.pathGlob !== "string" || !h.when.pathGlob))
      )
        throw new Error("Invalid hook condition");
    }
    return { ...structuredClone(h), project, timeoutSec };
  });
}

/** Unconditional implement receipt checks run once at integration, not once per model round. */
export function isWaveHook(h: ShellHook): boolean {
  return (
    h.step === "receipt" &&
    h.timing === "after" &&
    h.when?.phases?.length === 1 &&
    h.when.phases[0] === "implement" &&
    !h.when.tools &&
    !h.when.pathGlob &&
    !h.when.agents &&
    !!h.command &&
    !h.onMatch
  );
}

export function projectHookApproval(
  hooks: readonly ShellHook[],
  approve: (
    hooks: readonly ShellHook[],
    signal: AbortSignal,
  ) => Promise<boolean>,
) {
  let pending: Promise<boolean> | undefined;
  return (signal: AbortSignal) => {
    signal.throwIfAborted();
    const project = hooks.filter((h) => h.project);
    return project.length
      ? (pending ??= approve(project, signal))
      : Promise.resolve(true);
  };
}

export function shellHooks(options: {
  hooks: readonly ShellHook[];
  cwd: string;
  agent: string;
  phase(): string;
  bash: Tool;
  approve(signal: AbortSignal): Promise<boolean>;
  redact?(text: string): string;
  onReceipt?(receipt: Receipt): void;
}): { beforeStep: StepHook; afterStep: StepHook } {
  const clean = options.redact ?? ((s: string) => s);
  const run =
    (timing: ShellHook["timing"]): StepHook =>
    async (step, ctx, signal) => {
      const injections: string[] = [];
      for (const h of options.hooks) {
        if (h.step !== step || h.timing !== timing || isWaveHook(h)) continue;
        const w = h.when;
        if (w?.agents && !w.agents.includes(options.agent)) continue;
        if (w?.phases && !w.phases.includes(options.phase())) continue;
        // Before tool_use the model completion is available; afterwards validated calls are available.
        const calls = ctx.calls.length
          ? ctx.calls
          : (ctx.completion?.message.content ?? []).flatMap((b) =>
              b.type === "tool_use"
                ? [{ id: b.id, name: b.name, input: b.input }]
                : [],
            );
        const selected = calls.filter(
          (c) => !w?.tools || w.tools.includes(c.name),
        );
        if (w?.tools && !selected.length) continue;
        const files = [
          ...new Set(
            selected.flatMap((c) => {
              const path = (c.input as { path?: unknown } | null)?.path;
              if (typeof path !== "string") return [];
              const rel = relative(
                options.cwd,
                resolve(options.cwd, path),
              ).replaceAll("\\", "/");
              if (
                !rel ||
                isAbsolute(rel) ||
                rel === ".." ||
                rel.startsWith("../")
              )
                return [];
              return !w?.pathGlob || matchesGlob(rel, w.pathGlob) ? [rel] : [];
            }),
          ),
        ];
        if (w?.pathGlob && !files.length) continue;
        signal.throwIfAborted();
        const startedAt = new Date().toISOString();
        let result: HookResult;
        let output = "";
        try {
          if (h.project && !(await options.approve(signal)))
            result = { kind: "stop", reason: "project_hooks_rejected" };
          else if (h.onMatch === "block")
            result = { kind: "block", reason: clean(h.reason!) };
          else {
            // Each file is a PowerShell single-quoted literal, including embedded quote characters.
            const command = h.command!.replaceAll(
              "{{files}}",
              files.map((f) => "'" + f.replaceAll("'", "''") + "'").join(" "),
            );
            const input = { command, timeoutSec: h.timeoutSec };
            const error = await options.bash.validate(input);
            const execution = error
              ? { content: error, isError: true }
              : await options.bash.execute(input, signal);
            signal.throwIfAborted();
            output = clean(execution.content);
            result = execution.isError
              ? h.onFailure === "inject"
                ? { kind: "inject", message: `${h.id}: ${output}` }
                : { kind: "stop", reason: "hook_failed" }
              : { kind: "continue" };
          }
        } catch {
          result = {
            kind: "stop",
            reason: signal.aborted ? "aborted" : "hook_failed",
          };
          output = signal.aborted ? "Hook aborted" : "Hook process failed";
        }
        options.onReceipt?.({
          round: ctx.round,
          provider: "hook",
          model: ctx.request?.model ?? "",
          tool: h.id,
          step,
          timing,
          input: { id: h.id, command: clean(h.command ?? ""), files },
          output,
          detail:
            result.kind === "block" || result.kind === "stop"
              ? result.reason
              : output,
          decision: result.kind,
          startedAt,
          completedAt: new Date().toISOString(),
        });
        if (result.kind === "stop" || result.kind === "block") return result;
        if (result.kind === "inject") injections.push(result.message);
      }
      return injections.length
        ? { kind: "inject", message: injections.join("\n") }
        : { kind: "continue" };
    };
  return { beforeStep: run("before"), afterStep: run("after") };
}
