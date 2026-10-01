import { type AgentConfig } from "../agents/definitions.js";
import { type Tool } from "../tools/registry.js";
/** Integration checks share project approval with the generic STEP dispatcher. */
export function waveChecks(
  hooks: AgentConfig["waveChecks"],
  bash: Tool,
  approveProject: (
    hooks: AgentConfig["waveChecks"],
    signal: AbortSignal,
  ) => Promise<boolean>,
  onResult?: (
    hook: AgentConfig["waveChecks"][number],
    result: string,
    ok: boolean,
    duration: number,
  ) => void,
) {
  let approved = false;
  return async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const project = hooks.filter((h) => h.project);
    if (project.length && !approved) {
      if (!(await approveProject(project, signal)))
        return { ok: false, output: "Project wave checks were not approved" };
      approved = true;
    }
    for (const hook of hooks) {
      signal.throwIfAborted();
      const input = { command: hook.command, timeoutSec: hook.timeoutSec };
      const error = await bash.validate(input);
      if (error) return { ok: false, output: error };
      const started = Date.now();
      const result = await bash.execute(input, signal);
      signal.throwIfAborted();
      onResult?.(hook, result.content, !result.isError, Date.now() - started);
      if (result.isError) return { ok: false, output: result.content };
    }
    return {
      ok: true,
      output: hooks.length
        ? "Wave checks passed"
        : "No wave check hooks configured",
    };
  };
}
