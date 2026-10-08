import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MessageChannel } from "node:worker_threads";
import { build } from "vite";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { managedClaudeStart, probeManagedSdk } from "./sdk-worker-client.js";
import { SdkWorkerRpc } from "./sdk-worker-rpc.js";
import { approvePersonalQuery } from "../../connections/personal-sdk.js";

let root: string, sdk: string, workerUrl: URL;
const fakeSdk = `
import { writeFileSync } from 'node:fs';
export function query({options, prompt}) {
 const mode = options.env.MODE;
 if (mode === 'throw') throw new Error('never-persist-secret');
 const active = {
  accountInfo: async () => {
   if (mode === 'hang') await new Promise(() => {});
   if (mode === 'exit') process.exit(17);
   if (mode === 'error') throw new Error('never-persist-secret');
   return { apiProvider: 'firstParty', subscriptionType: 'max' };
  },
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (opts) => {
   if (mode === 'approval' && opts?.skipBehaviors !== true) throw new Error('unsafe-usage-behaviors');
   return mode === 'approval' ? {subscription_type:'max', rate_limits_available:true, rate_limits:{extra_usage:{is_enabled:false}}} : { rate_limits: {} };
  },
  supportedModels: async () => [{value: options.model}],
  close: () => { if (options.env.CLOSED) writeFileSync(options.env.CLOSED, 'closed'); },
  async *[Symbol.asyncIterator]() {
   if (typeof options.spawnClaudeCodeProcess !== 'function' || !options.abortController)
    throw new Error('missing containment');
   const input = await prompt[Symbol.asyncIterator]().next();
   const metadata = { signal: options.abortController.signal, toolUseID: 'tool-1', blockedPath: '/blocked' };
   const permission = await options.canUseTool('Read', {file_path: 'target'}, metadata);
   const hook = await options.hooks.PreToolUse[0].hooks[0]({hook_event_name: 'PreToolUse', tool_name:'Read', tool_use_id:'tool-1', tool_input:{}}, 'tool-1', metadata);
   yield { type: 'result', permission, hook, text: input.value.message.content, tools: options.tools };
  }
 };
 if (mode === 'contract') delete active.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
 return active;
}`;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "xh-sdk-worker-"));
  sdk = join(root, "fake-sdk.mjs");
  await writeFile(sdk, fakeSdk);
  await build({
    configFile: false,
    logLevel: "silent",
    ssr: { noExternal: true },
    build: {
      ssr: resolve("src/main/workflow/official/sdk-worker.ts"),
      outDir: join(root, "worker"),
      rolldownOptions: {
        external: /^node:/,
        output: { format: "es", entryFileNames: "sdk-worker.mjs" },
      },
    },
  });
  workerUrl = pathToFileURL(join(root, "worker", "sdk-worker.mjs"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
function request(mode = "ok", overrides: Partial<Options> = {}) {
  const options: Options = {
    cwd: root,
    model: "synthetic-model",
    env: { MODE: mode },
    tools: ["Read"],
    abortController: new AbortController(),
    canUseTool: async () => ({ behavior: "deny", message: "boundary" }),
    hooks: { PreToolUse: [{ hooks: [async () => ({ continue: false })] }] },
    ...overrides,
  };
  return {
    options,
    prompt: (async function* () {
      yield {
        type: "user",
        session_id: "",
        parent_tool_use_id: null,
        message: { role: "user", content: "synthetic input" },
      } satisfies SDKUserMessage;
    })(),
  };
}
describe("managed SDK worker", () => {
  it("preserves skipBehaviors for the actual personal-subscription approval gate", async () => {
    const active = managedClaudeStart(sdk, { workerUrl })(request("approval"));
    try {
      await expect(approvePersonalQuery(active)).resolves.toBeUndefined();
    } finally {
      active.close();
    }
  });
  it("probes exports without query or native/auth execution", async () => {
    const probe = join(root, "probe.mjs");
    await writeFile(
      probe,
      "export function query() { throw new Error('must-not-query'); }",
    );
    await expect(
      probeManagedSdk(probe, { workerUrl }),
    ).resolves.toBeUndefined();
  });
  it("rejects missing query exports and broken imports without leaking SDK errors", async () => {
    for (const source of [
      "export const unrelated = 1",
      "throw new Error('never-persist-secret')",
    ]) {
      const broken = join(root, "broken.mjs");
      await writeFile(broken, source);
      await expect(probeManagedSdk(broken, { workerUrl })).rejects.toThrow(
        "managed-sdk-worker-unavailable",
      );
    }
  });
  it("preserves held prompts, control methods, callbacks and scoped options", async () => {
    const input = request();
    let toolCalls = 0,
      hookCalls = 0;
    input.options.canUseTool = async (name, args, context) => {
      expect(name).toBe("Read");
      expect(args.file_path).toBe("target");
      expect(context.toolUseID).toBe("tool-1");
      expect(context.blockedPath).toBe("/blocked");
      expect(context.signal).toBeInstanceOf(AbortSignal);
      toolCalls++;
      return { behavior: "deny", message: "scoped denial" };
    };
    input.options.hooks = {
      PreToolUse: [
        {
          hooks: [
            async (hook, id, context) => {
              expect(hook.hook_event_name).toBe("PreToolUse");
              expect(id).toBe("tool-1");
              expect(context.signal.aborted).toBe(false);
              hookCalls++;
              return { continue: false };
            },
          ],
        },
      ],
    };
    const active = managedClaudeStart(sdk, { workerUrl })(input);
    try {
      expect(await active.accountInfo()).toMatchObject({
        subscriptionType: "max",
      });
      expect(await active.supportedModels()).toEqual([
        { value: "synthetic-model" },
      ]);
      expect(
        await active.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      ).toEqual({ rate_limits: {} });
      expect(toolCalls).toBe(0);
      const next = await active[Symbol.asyncIterator]().next();
      expect(next.value).toMatchObject({
        text: "synthetic input",
        permission: { behavior: "deny" },
        hook: { continue: false },
        tools: ["Read"],
      });
      expect([toolCalls, hookCalls]).toEqual([1, 1]);
    } finally {
      active.close();
    }
  });
  it.each(["throw", "contract", "error", "exit"])(
    "fails closed for %s without bundled fallback",
    async (mode) => {
      const active = managedClaudeStart(sdk, { workerUrl })(request(mode));
      try {
        await expect(active.accountInfo()).rejects.toThrow(
          "managed-sdk-worker-unavailable",
        );
      } finally {
        active.close();
      }
    },
  );
  it("times out unresponsive controls", async () => {
    const active = managedClaudeStart(sdk, { workerUrl, rpcTimeoutMs: 500 })(
      request("hang"),
    );
    try {
      await expect(active.accountInfo()).rejects.toThrow(
        "managed-sdk-worker-unavailable",
      );
    } finally {
      active.close();
    }
  });
  it("aborts pending calls and closes the SDK once", async () => {
    const marker = join(root, "close-marker");
    const input = request("ok", { env: { MODE: "ok", CLOSED: marker } });
    const active = managedClaudeStart(sdk, { workerUrl })(input);
    await active.accountInfo();
    input.options.abortController!.abort();
    active.close();
    await expect(active.supportedModels()).rejects.toThrow(
      "managed-sdk-worker-unavailable",
    );
    await expect.poll(() => readFile(marker, "utf8")).toBe("closed");
  });
  it("pins SDK versions in separate module caches", async () => {
    const versions = await Promise.all(
      ["one", "two"].map(async (model) => {
        const entry = join(root, `${model}.mjs`);
        await writeFile(
          entry,
          fakeSdk.replace("value: options.model", `value: '${model}'`),
        );
        return managedClaudeStart(entry, { workerUrl })(request());
      }),
    );
    try {
      expect(
        await Promise.all(versions.map((v) => v.supportedModels())),
      ).toEqual([[{ value: "one" }], [{ value: "two" }]]);
    } finally {
      versions.forEach((v) => v.close());
    }
  });
});
describe("SDK worker RPC bounds", () => {
  it("does not replace phase deadlines with a premature 60s transport timeout", async () => {
    vi.useFakeTimers();
    const rpc = new SdkWorkerRpc(
      { postMessage() {}, on() {}, off() {} },
      () => {},
    );
    try {
      let settled = false;
      const pending = rpc.call("next").catch(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(120001);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(900000);
      await pending;
      expect(settled).toBe(true);
    } finally {
      rpc.close();
      vi.useRealTimers();
    }
  });
  it("propagates individual callback cancellation and ignores late replies", async () => {
    const { port1, port2 } = new MessageChannel();
    let received: AbortSignal | undefined;
    const receiver = new SdkWorkerRpc(port2, async (_name, _args, signal) => {
      received = signal;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return "late allowance";
    });
    const sender = new SdkWorkerRpc(port1, () => {}),
      abort = new AbortController();
    try {
      const pending = sender.call("callback", [], abort.signal);
      const failed = expect(pending).rejects.toThrow(
        "managed-sdk-worker-unavailable",
      );
      await expect.poll(() => !!received).toBe(true);
      abort.abort();
      await failed;
      await expect.poll(() => received?.aborted).toBe(true);
    } finally {
      sender.close();
      receiver.close();
      port1.close();
      port2.close();
    }
  });
  it("bounds pending requests and oversized payloads", async () => {
    const { port1, port2 } = new MessageChannel();
    const rpc = new SdkWorkerRpc(port1, () => {});
    try {
      await expect(
        rpc.call("large", ["x".repeat(8 * 1024 * 1024)]),
      ).rejects.toThrow("managed-sdk-worker-unavailable");
      const pending = Array.from({ length: 64 }, () =>
        rpc.call("hang").catch(() => "closed"),
      );
      await expect(rpc.call("overflow")).rejects.toThrow(
        "managed-sdk-worker-unavailable",
      );
      rpc.close();
      expect(await Promise.all(pending)).toHaveLength(64);
    } finally {
      rpc.close();
      port1.close();
      port2.close();
    }
  });
});
