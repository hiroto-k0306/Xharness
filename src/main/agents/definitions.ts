import {
  parseShellHooks,
  isWaveHook,
  type ShellHook,
} from "../hooks/shell-hooks.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { isEffort } from "../config/config.js";
import { type ReasoningEffort } from "../providers/provider.js";
import { HISTORY_TOOLS } from "../tools/project-history.js";

export interface AgentDefinition {
  model: string;
  effort?: ReasoningEffort;
  tools: string[];
}
export interface AgentConfig {
  hooks?: ShellHook[];
  waveChecks: {
    id: string;
    command: string;
    timeoutSec: number;
    project: boolean;
  }[];
  agents: Record<string, AgentDefinition>;
  workflow: {
    mode: "auto" | "always" | "off";
    planApproval: "ask" | "auto";
    reviewRounds: number;
    worktrees: boolean;
  };
}
/**
 * `trusted` is whether the user trusted the workspace. An untrusted project's
 * `.xharness/config.yaml` may only tighten the plan approval (`ask`), never skip it.
 */
export async function loadAgentConfig(
  home: string,
  cwd?: string,
  trusted = false,
): Promise<AgentConfig> {
  const config: AgentConfig = {
    waveChecks: [],
    agents: {
      explorer: {
        model: "claude:sonnet",
        tools: ["Read", "Grep", "Glob", "WebFetch"],
      },
      reviewer: {
        model: "codex:sol",
        effort: "high",
        tools: ["Read", "Grep", "Glob", "Bash"],
      },
    },
    workflow: {
      mode: "auto",
      planApproval: "ask",
      reviewRounds: 5,
      worktrees: true,
    },
  };
  const projectConfig = cwd ? join(cwd, ".xharness/config.yaml") : undefined;
  for (const path of [
    join(home, "config.yaml"),
    ...(projectConfig ? [projectConfig] : []),
  ]) {
    let doc: Record<string, unknown>;
    try {
      doc = parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Agent configuration unavailable");
    }
    if (!doc || typeof doc !== "object") continue;
    const hooks = parseShellHooks(
      doc.hooks,
      !!cwd && path === join(cwd, ".xharness/config.yaml"),
    );
    (config.hooks ??= []).push(...hooks);
    config.waveChecks.push(
      ...hooks.filter(isWaveHook).map((h) => ({
        id: h.id,
        command: h.command!,
        timeoutSec: h.timeoutSec,
        project: h.project,
      })),
    );
    if (doc.agents && typeof doc.agents === "object") {
      for (const [name, value] of Object.entries(doc.agents)) {
        if (
          !/^[\w-]+$/.test(name) ||
          ["__proto__", "constructor", "prototype"].includes(name) ||
          name === "worker" ||
          name === "main" ||
          !value ||
          typeof value !== "object"
        )
          throw new Error("Invalid agent definition");
        const agent = value as AgentDefinition;
        if (
          typeof agent.model !== "string" ||
          !Array.isArray(agent.tools) ||
          agent.tools.some(
            (t) =>
              ![
                "Read",
                "Grep",
                "Glob",
                "WebFetch",
                "Bash",
                ...HISTORY_TOOLS,
              ].includes(t),
          ) ||
          (agent.effort !== undefined && !isEffort(agent.effort))
        )
          throw new Error("Invalid readonly agent definition");
        config.agents[name] = {
          model: agent.model,
          tools: [...agent.tools],
          effort: agent.effort,
        };
      }
    }
    const w = doc.workflow as Partial<AgentConfig["workflow"]> | undefined;
    if (w) {
      if (w.mode && ["auto", "always", "off"].includes(w.mode))
        config.workflow.mode = w.mode;
      if (
        w.planApproval &&
        ["ask", "auto"].includes(w.planApproval) &&
        (w.planApproval === "ask" || trusted || path !== projectConfig)
      )
        config.workflow.planApproval = w.planApproval;
      if (
        Number.isSafeInteger(w.reviewRounds) &&
        w.reviewRounds! >= 1 &&
        w.reviewRounds! <= 10
      )
        config.workflow.reviewRounds = w.reviewRounds!;
      if (typeof w.worktrees === "boolean")
        config.workflow.worktrees = w.worktrees;
    }
  }
  return config;
}
