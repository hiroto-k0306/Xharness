import { expect, it, vi } from "vitest";
import { AutoRefresh } from "../auth/auto-refresh.js";
import { RefreshingProvider } from "./auth-refresh.js";
import { type Provider, type ProviderEvent } from "./provider.js";

function fixture(
  expiry: number,
  status?: number,
  updates = true,
  keepStatus = false,
) {
  const stream = vi.fn(async function* () {
    if (status)
      yield {
        type: "error",
        error: {
          kind: "authentication",
          status,
          message: "denied",
          retryable: false,
        },
      } as ProviderEvent;
    else yield { type: "text_delta", text: "ok" } as ProviderEvent;
  });
  const execute = vi.fn(async () => {
    if (updates) {
      expiry += 3600000;
      if (!keepStatus) status = undefined;
    }
    return "success" as const;
  });
  const refresh = new AutoRefresh({
    settings: async () => ({ autoRefresh: true }),
    expiry: async () => expiry,
    execute,
  });
  const provider = new RefreshingProvider(
    { id: "claude", models: () => [], stream } as Provider,
    refresh,
  );
  return { provider, execute, stream };
}
async function collect(
  provider: Provider,
  signal = new AbortController().signal,
) {
  const events = [];
  for await (const event of provider.stream(
    { model: "fake", system: "", tools: [], messages: [] },
    signal,
  ))
    events.push(event);
  return events;
}
it("does not run CLI before expiry", async () => {
  const f = fixture(Date.now() + 3600000);
  expect(await collect(f.provider)).toEqual([
    { type: "text_delta", text: "ok" },
  ]);
  expect(f.execute).not.toHaveBeenCalled();
});
it("refreshes before dispatch, with a safe result event", async () => {
  const f = fixture(Date.now() - 1000);
  const results = await Promise.all(
    Array.from({ length: 6 }, () => collect(f.provider)),
  );
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.stream).toHaveBeenCalledTimes(6);
  expect(results.every((e) => e[0]?.type === "auth_refresh")).toBe(true);
});
it("refreshes on 401 and resends exactly once", async () => {
  const f = fixture(Date.now() + 3600000, 401);
  expect((await collect(f.provider)).map((e) => e.type)).toEqual([
    "auth_refresh",
    "text_delta",
  ]);
  expect(f.stream).toHaveBeenCalledTimes(2);
  expect(f.execute).toHaveBeenCalledTimes(1);
});
it("does not refresh on 403", async () => {
  const f = fixture(Date.now() + 3600000, 403);
  expect((await collect(f.provider))[0]?.type).toBe("error");
  expect(f.execute).not.toHaveBeenCalled();
});
it("stops without sending if expired credentials were not updated", async () => {
  const f = fixture(Date.now() - 1000, undefined, false);
  expect((await collect(f.provider)).map((e) => e.type)).toEqual([
    "auth_refresh",
    "error",
  ]);
  expect(f.stream).not.toHaveBeenCalled();
});
it("never loops on another 401 after a refresh", async () => {
  const f = fixture(Date.now() + 3600000, 401, true, true);
  expect((await collect(f.provider)).at(-1)?.type).toBe("error");
  expect(f.stream).toHaveBeenCalledTimes(2);
  expect(f.execute).toHaveBeenCalledTimes(1);
});
it("stopping one worker does not cancel shared refresh or resend its request", async () => {
  let finish!: () => void;
  const execute = vi.fn(
    () =>
      new Promise<"success">((resolve) => {
        finish = () => resolve("success");
      }),
  );
  const refresh = new AutoRefresh({
    settings: async () => ({ autoRefresh: true }),
    expiry: async () => 1,
    execute,
  });
  const stream = vi.fn(async function* () {});
  const provider = new RefreshingProvider(
    { id: "codex", models: () => [], stream },
    refresh,
  );
  const abort = new AbortController();
  const pending = collect(provider, abort.signal);
  const rejected = expect(pending).rejects.toThrow("Aborted");
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  abort.abort();
  await rejected;
  finish();
  expect(stream).not.toHaveBeenCalled();
});
