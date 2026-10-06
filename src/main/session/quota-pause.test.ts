import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { QuotaPauses, type QuotaPause } from "./quota-pause.js";
import { quotaWait } from "./quota-capture.js";
import { JsonFile } from "./store.js";

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    homes.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
const record = (sessionId = "one", nextCheckAt: number | undefined = 1000) => ({
  sessionId,
  provider: "claude",
  model: "claude:sonnet",
  scope: "5h",
  nextCheckAt,
  eligible: true,
  reason: "quota",
  observed: { receivedAt: 0, retryAfterSec: 1, scope: "5h" },
  snapshot: {
    taskId: sessionId,
    originalTask: { userMessageIndex: 0 },
    phase: "off",
    unfinished: ["task"],
    effort: "high",
    premiseHash: "premise",
    messagesHash: "messages",
    messageCount: 1,
    checkpointHash: "checkpoint",
    conditionsHash: "conditions",
    cwd: "root",
    workspaceId: null,
    readOnly: false,
    results: [],
    approval: "current-policy-only" as const,
  },
});
async function fixture(
  resume = vi.fn(
    async (_p: QuotaPause, _s: AbortSignal): Promise<string | undefined> => {
      void _p;
      void _s;
      return undefined;
    },
  ),
) {
  const home = await mkdtemp(join(tmpdir(), "xh-quota-"));
  homes.push(home);
  let now = 0;
  const host = {
    home,
    now: () => now,
    changed: async () => {},
    busy: () => false,
    resume,
    timers: false,
  };
  const store = new QuotaPauses(host);
  await store.load();
  return {
    home,
    host,
    store,
    resume,
    advance: (value: number) => {
      now = value;
    },
  };
}
it("requires explicit opt-in, waits until observed reset, persists claim and never duplicates parallel ticks", async () => {
  const f = await fixture(
    vi.fn(async (p) => {
      const disk = JSON.parse(
        await readFile(join(f.home, "quota-pauses.json"), "utf8"),
      );
      expect(disk[0].state).toBe("running");
      expect(p.attempts).toBe(1);
      return undefined;
    }),
  );
  await f.store.put(record());
  f.advance(2000);
  await f.store.tick();
  expect(f.resume).not.toHaveBeenCalled();
  f.advance(0);
  await f.store.action("one", "enable");
  await f.store.tick();
  expect(f.resume).not.toHaveBeenCalled();
  f.advance(1000);
  await Promise.all([f.store.tick(), f.store.tick()]);
  expect(f.resume).toHaveBeenCalledTimes(1);
  expect(f.store.view("one")?.state).toBe("completed");
});
it("restores opted-in waiting but never retries an uncertain running claim", async () => {
  const f = await fixture();
  await f.store.put(record());
  await f.store.action("one", "enable");
  await f.store.close();
  const restored = new QuotaPauses(f.host);
  await restored.load();
  f.advance(1000);
  await restored.tick();
  expect(f.resume).toHaveBeenCalledTimes(1);
  const rows = JSON.parse(
    await readFile(join(f.home, "quota-pauses.json"), "utf8"),
  );
  rows[0].state = "running";
  await writeFile(join(f.home, "quota-pauses.json"), JSON.stringify(rows));
  const uncertain = new QuotaPauses(f.host);
  await uncertain.load();
  await uncertain.tick();
  expect(uncertain.view("one")).toMatchObject({
    state: "manual",
    eligible: false,
  });
  expect(f.resume).toHaveBeenCalledTimes(1);
});
it("unknown reset stays unknown and requires an explicit manual recheck", async () => {
  const f = await fixture();
  await f.store.put({ ...record(), nextCheckAt: undefined });
  expect(f.store.view("one")).toMatchObject({
    state: "manual",
    nextCheckAt: undefined,
  });
  expect(await f.store.action("one", "enable")).toBeDefined();
  f.advance(999999);
  await f.store.tick();
  expect(f.resume).not.toHaveBeenCalled();
  await f.store.action("one", "now");
  await f.store.tick();
  expect(f.resume).toHaveBeenCalledTimes(1);
});
it("cancel and expiry prevent continuation", async () => {
  const f = await fixture();
  await f.store.put(record());
  await f.store.action("one", "enable");
  await f.store.cancel("one", "stop");
  f.advance(1000);
  await f.store.tick();
  expect(f.store.view("one")?.state).toBe("cancelled");
  await f.store.put(record("two"));
  await f.store.action("two", "enable");
  f.advance(15 * 86400000);
  await f.store.tick();
  expect(f.store.view("two")?.state).toBe("expired");
  expect(f.resume).not.toHaveBeenCalled();
});
it("shared provider pool respects weekly reset and blocks unknown peer waits", async () => {
  const f = await fixture();
  await f.store.put(record());
  await f.store.put({ ...record("weekly", 7000), scope: "7d" });
  await f.store.action("one", "enable");
  f.advance(1000);
  await f.store.tick();
  expect(f.store.view("one")?.nextCheckAt).toBe(7000);
  expect(f.resume).not.toHaveBeenCalled();
  await f.store.put({ ...record("unknown"), nextCheckAt: undefined });
  f.advance(7000);
  await f.store.tick();
  expect(f.store.view("one")?.state).toBe("manual");
  expect(f.resume).not.toHaveBeenCalled();
});
it("claim storage failure prevents all provider and tool calls", async () => {
  const f = await fixture();
  await f.store.put(record());
  await f.store.action("one", "enable");
  vi.spyOn(JsonFile.prototype, "write").mockRejectedValue(
    new Error("disk failure"),
  );
  f.advance(1000);
  await f.store.tick();
  expect(f.resume).not.toHaveBeenCalled();
  expect(f.store.view("one")).toMatchObject({
    state: "manual",
    eligible: false,
  });
});
it("repeated quota waits retain consent, original expiry and cap attempts", async () => {
  const f = await fixture(
    vi.fn(async () => {
      await f.store.put(record("one", f.host.now()));
      return "quota";
    }),
  );
  await f.store.put(record());
  const expiresAt = f.store.view("one")!.expiresAt;
  await f.store.action("one", "enable");
  f.advance(1000);
  await f.store.tick();
  await f.store.tick();
  await f.store.tick();
  await f.store.tick();
  expect(f.resume).toHaveBeenCalledTimes(3);
  expect(f.store.view("one")).toMatchObject({
    state: "manual",
    eligible: false,
    attempts: 3,
    expiresAt,
  });
});
it("cancellation aborts a live lease and cannot be overwritten by its result", async () => {
  let finish!: () => void;
  const f = await fixture(
    vi.fn(async (_p, signal) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      expect(signal.aborted).toBe(true);
      return undefined;
    }),
  );
  await f.store.put(record());
  await f.store.action("one", "enable");
  f.advance(1000);
  const pending = f.store.tick();
  await vi.waitFor(() => expect(f.resume).toHaveBeenCalled());
  await f.store.action("one", "cancel");
  finish();
  await pending;
  expect(f.store.view("one")?.state).toBe("cancelled");
});
it("only explicit valid quota data supplies an absolute reset", () => {
  const rate = { provider: "claude", model: "model", receivedAt: 1000 };
  expect(quotaWait(rate).nextCheckAt).toBeUndefined();
  expect(quotaWait({ ...rate, retryAfterSec: 600, scope: "5h" })).toEqual({
    nextCheckAt: 601000,
    scope: "5h",
  });
  expect(
    quotaWait({
      ...rate,
      windows: [
        {
          name: "week",
          windowMinutes: 10080,
          usedPercent: 100,
          resetAt: new Date(7000).toISOString(),
        },
      ],
    }),
  ).toEqual({ nextCheckAt: 7000, scope: "7d" });
  expect(
    quotaWait({
      ...rate,
      retryAfterSec: 600,
      windows: [{ name: "week", usedPercent: 100 }],
    }).nextCheckAt,
  ).toBeUndefined();
  expect(quotaWait({ ...rate, retryAfterSec: -1 }).nextCheckAt).toBeUndefined();
});
