import {
  query,
  tool,
  createSdkMcpServer,
  type Options,
  type Query,
  type HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SdkBinding, SdkOptions } from "./claude.js";
import { BoundaryError } from "./contracts.js";

type QueryPort = (
  request: Parameters<typeof query>[0],
) => Pick<Query, typeof Symbol.asyncIterator | "close">;
/** Official SDK API binding; construction never launches a process or reads credentials. */
export function officialSdkBinding(
  config: {
    cwd: string;
    subscriptionOnlyConfirmed: boolean;
    env: NodeJS.ProcessEnv;
  },
  start: QueryPort = query,
): SdkBinding {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.keys(config.env).map((key) => [key, undefined]),
  );
  for (const key of Object.keys(process.env))
    if (!Object.hasOwn(env, key)) env[key] = undefined;
  // No API credentials, proxy routes, plugins, arbitrary NODE_OPTIONS, or shell overrides.
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "CLAUDE_CONFIG_DIR",
  ])
    if (config.env[key] !== undefined) env[key] = config.env[key];
  return {
    subscriptionUseConfirmed: config.subscriptionOnlyConfirmed,
    createXServer(handlers) {
      return createSdkMcpServer({
        name: "xharness",
        version: "1.0.0",
        alwaysLoad: true,
        tools: Object.entries(handlers).map(([name, handler]) =>
          tool(
            name,
            `X-owned ${name}`,
            {
              id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
              input: z.record(z.string(), z.unknown()),
            },
            async (args) => {
              try {
                const result = await handler({
                  id: args.id,
                  tool: name,
                  input: args.input,
                });
                if (!result || typeof result !== "object")
                  throw new BoundaryError("malformed");
                const value = result as {
                  content?: unknown;
                  isError?: unknown;
                };
                const content = z
                  .array(
                    z.object({ type: z.literal("text"), text: z.string() }),
                  )
                  .parse(value.content);
                return {
                  content,
                  ...(value.isError === true ? { isError: true } : {}),
                };
              } catch {
                return {
                  isError: true,
                  content: [{ type: "text" as const, text: "X tool failed" }],
                };
              }
            },
            { alwaysLoad: true },
          ),
        ),
      });
    },
    async *query(request) {
      if (!config.subscriptionOnlyConfirmed)
        throw new BoundaryError("unconfigured");
      const options = sdkOptions(request.options, config.cwd, env);
      const active = start({ prompt: request.prompt, options });
      const close = () => active.close();
      options.abortController!.signal.addEventListener("abort", close, {
        once: true,
      });
      try {
        yield* active;
      } finally {
        options.abortController!.signal.removeEventListener("abort", close);
        active.close();
      }
    },
  };
}
/** Explicit translation: unknown port properties cannot accidentally reach SDK defaults. */
export function sdkOptions(
  input: SdkOptions,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Options {
  return {
    cwd,
    env,
    model: input.model,
    effort: input.effort,
    systemPrompt: input.systemPrompt,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    plugins: [],
    skills: [],
    settings: { autoMemoryEnabled: false },
    mcpServers: input.mcpServers as NonNullable<Options["mcpServers"]>,
    allowedTools: input.allowedTools,
    permissionMode: "dontAsk",
    persistSession: false,
    maxTurns: input.maxTurns,
    abortController: input.abortController,
    outputFormat: input.outputFormat,
    canUseTool: input.canUseTool,
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (hook) => {
              if (hook.hook_event_name !== "PreToolUse") return {};
              const result = await input.hooks.PreToolUse[0]!.hooks[0]!({
                tool_name: hook.tool_name,
              });
              return result as HookJSONOutput;
            },
          ],
        },
      ],
    },
  };
}
