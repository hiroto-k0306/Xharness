import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeQuery } from "./claude.js";
import { spawnOwnedProcess } from "./owned-process.js";
import { sdkExecutable } from "./sdk-executable.js";
import { SdkWorkerRpc } from "./sdk-worker-rpc.js";

const port = parentPort!;
const controller = new AbortController();
let active: ClaudeQuery | undefined;
let iterator: AsyncIterator<unknown> | undefined;
const rpc = new SdkWorkerRpc(
  port,
  async (name, args) => {
    await ready;
    controller.signal.throwIfAborted();
    if (name === "ready") return true;
    if (!active) throw new Error("managed-sdk-contract-unavailable");
    if (name === "next") return iterator!.next();
    if (name === "accountInfo") return active.accountInfo();
    if (name === "usage")
      return active.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(
        ...(args as Parameters<
          ClaudeQuery["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"]
        >),
      );
    if (name === "supportedModels") return active.supportedModels();
    throw new Error("managed-sdk-method-unavailable");
  },
  workerData.timeoutMs,
);

let closing = false;
function close() {
  if (closing) return;
  closing = true;
  controller.abort();
  try {
    active?.close();
  } catch {
    /* Do not forward SDK errors. */
  }
  rpc.close();
  port.close();
}
port.on("message", (message) => {
  if (message?.kind === "close") close();
});
port.on("close", close);

const ready = (async () => {
  const sdk = await import(
    /* @vite-ignore */ pathToFileURL(workerData.sdkEntry).href
  );
  if (typeof sdk.query !== "function")
    throw new Error("managed-sdk-contract-unavailable");
  if (workerData.probe) return;
  controller.signal.throwIfAborted();
  const options: Options = {
    ...workerData.options,
    abortController: controller,
    stderr: () => {},
    spawnClaudeCodeProcess: (spawn) =>
      spawnOwnedProcess(sdkExecutable(spawn.command), spawn.args, {
        cwd: spawn.cwd ?? workerData.options.cwd,
        env: spawn.env,
        signal: spawn.signal
          ? AbortSignal.any([controller.signal, spawn.signal])
          : controller.signal,
      }),
  };
  if (workerData.canUseTool)
    options.canUseTool = async (name, input, context) => {
      const { signal, ...metadata } = context;
      return (await rpc.call(
        "canUseTool",
        [name, input, metadata],
        signal,
      )) as Awaited<ReturnType<NonNullable<Options["canUseTool"]>>>;
    };
  if (workerData.hooks) {
    options.hooks = Object.fromEntries(
      Object.entries(workerData.hooks).map(([event, matchers]) => [
        event,
        (
          matchers as { matcher?: string; timeout?: number; ids: string[] }[]
        ).map(({ ids, ...matcher }) => ({
          ...matcher,
          hooks: ids.map(
            (id) =>
              async (
                input: unknown,
                toolUseID: string | undefined,
                context: { signal: AbortSignal },
              ) =>
                rpc.call(id, [input, toolUseID], context.signal),
          ),
        })),
      ]),
    ) as Options["hooks"];
  }
  active = sdk.query({
    options,
    prompt: {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            rpc.call("promptNext") as Promise<IteratorResult<SDKUserMessage>>,
        };
      },
    },
  });
  if (
    !active ||
    [
      "accountInfo",
      "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET",
      "supportedModels",
      "close",
      Symbol.asyncIterator,
    ].some(
      (name) =>
        typeof (active as unknown as Record<string | symbol, unknown>)[name] !==
        "function",
    )
  ) {
    close();
    throw new Error("managed-sdk-contract-unavailable");
  }
  iterator = active[Symbol.asyncIterator]();
  if (typeof iterator?.next !== "function")
    throw new Error("managed-sdk-contract-unavailable");
})();
// A failed import/query is surfaced only by the sanitized RPC response.
void ready.catch(() => {});
