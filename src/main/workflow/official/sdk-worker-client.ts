import { Worker } from "node:worker_threads";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeQuery, ClaudeStart } from "./claude.js";
import { SdkWorkerRpc } from "./sdk-worker-rpc.js";

type Configuration = { workerUrl?: URL; rpcTimeoutMs?: number };
function launch(
  data: Record<string, unknown>,
  configuration: Configuration,
  handle: ConstructorParameters<typeof SdkWorkerRpc>[1],
) {
  const worker = new Worker(
    configuration.workerUrl ?? new URL("./sdk-worker.js", import.meta.url),
    {
      workerData: { ...data, timeoutMs: configuration.rpcTimeoutMs ?? 900000 },
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      execArgv: [],
    },
  );
  // Never inherit raw SDK output into application logs.
  worker.stdout.resume();
  worker.stderr.resume();
  const rpc = new SdkWorkerRpc(worker, handle, configuration.rpcTimeoutMs);
  let closed = false;
  let termination: ReturnType<typeof setTimeout> | undefined;
  worker.once("error", () => rpc.close());
  worker.once("exit", () => {
    clearTimeout(termination);
    rpc.close();
  });
  const close = () => {
    if (closed) return;
    closed = true;
    rpc.close();
    worker.postMessage({ kind: "close" });
    // Give the owned-process AbortController time to release its Job lease.
    termination = setTimeout(() => {
      void worker.terminate();
    }, 1000);
    termination.unref();
  };
  return { rpc, close };
}

/** Import-only compatibility probe: no query, authentication or native process. */
export async function probeManagedSdk(
  sdkEntry: string,
  configuration: Configuration = {},
) {
  const worker = launch(
    { sdkEntry, probe: true },
    { rpcTimeoutMs: 10000, ...configuration },
    () => {
      throw new Error();
    },
  );
  try {
    await worker.rpc.call("ready");
  } finally {
    worker.close();
  }
}

/** Each query pins an immutable SDK entry in an isolated module cache. No fallback. */
export function managedClaudeStart(
  sdkEntry: string,
  configuration: Configuration = {},
): ClaudeStart {
  return ({ options, prompt }) => {
    const { abortController, canUseTool, hooks, ...serializable } = options;
    delete serializable.spawnClaudeCodeProcess;
    delete serializable.stderr;
    const callbacks = new Map<string, HookCallback>();
    const hookDefinitions =
      hooks &&
      Object.fromEntries(
        Object.entries(hooks).map(([event, matchers]) => [
          event,
          matchers.map(({ hooks: entries, ...matcher }, matcherIndex) => ({
            ...matcher,
            ids: entries.map((callback, index) => {
              const id = `hook:${event}:${matcherIndex}:${index}`;
              callbacks.set(id, callback);
              return id;
            }),
          })),
        ]),
      );
    const iterator = prompt[Symbol.asyncIterator]();
    const worker = launch(
      {
        sdkEntry,
        options: serializable,
        hooks: hookDefinitions,
        canUseTool: !!canUseTool,
      },
      configuration,
      async (name, args, signal) => {
        signal.throwIfAborted();
        if (name === "promptNext") return iterator.next();
        if (name === "canUseTool" && canUseTool) {
          const [tool, input, context] = args as [
            string,
            Record<string, unknown>,
            Omit<Parameters<NonNullable<Options["canUseTool"]>>[2], "signal">,
          ];
          return canUseTool(tool, input, { ...context, signal });
        }
        const callback = callbacks.get(name);
        if (callback)
          return callback(
            args[0] as Parameters<HookCallback>[0],
            args[1] as string | undefined,
            { signal },
          );
        throw new Error("managed-sdk-callback-unavailable");
      },
    );
    const close = () => {
      abortController?.signal.removeEventListener("abort", close);
      worker.close();
    };
    abortController?.signal.addEventListener("abort", close, { once: true });
    if (abortController?.signal.aborted) close();
    return {
      accountInfo: () =>
        worker.rpc.call("accountInfo") as ReturnType<
          ClaudeQuery["accountInfo"]
        >,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (...args) =>
        worker.rpc.call("usage", args) as ReturnType<
          ClaudeQuery["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"]
        >,
      supportedModels: () =>
        worker.rpc.call("supportedModels") as ReturnType<
          ClaudeQuery["supportedModels"]
        >,
      close,
      [Symbol.asyncIterator]: async function* () {
        try {
          while (true) {
            const next = (await worker.rpc.call("next")) as Awaited<
              ReturnType<
                ReturnType<ClaudeQuery[typeof Symbol.asyncIterator]>["next"]
              >
            >;
            if (next.done) return;
            yield next.value;
          }
        } finally {
          close();
        }
      },
    };
  };
}
