import { describe, expect, it, vi } from "vitest";
import { AutoRefresh, type RefreshResult } from "./auto-refresh.js";
import { refreshArguments, refreshEnvironment } from "./refresh-cli.js";

function fixture(result: RefreshResult["result"] = "success", updates = true) {
  let now = 1000,
    expiry = 100;
  const execute = vi.fn(async () => {
    if (updates) expiry = now + 3600000;
    return result;
  });
  const manager = new AutoRefresh({
    settings: async () => ({ autoRefresh: true }),
    expiry: async () => expiry,
    execute,
    now: () => now,
  });
  return {
    manager,
    execute,
    expire: () => {
      expiry = 100;
    },
    advance: () => {
      now += 600000;
    },
  };
}
describe("official CLI auto refresh (offline)", () => {
  it("validates new expiry and shares one result across workers", async () => {
    const f = fixture();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => f.manager.refresh("claude", 100)),
    );
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.result === "success")).toBe(true);
  });
  it.each(["unchanged", "timeout", "cli_missing", "failed"] as const)(
    "reports %s without retries",
    async (result) => {
      const f = fixture(result === "unchanged" ? "success" : result, false);
      expect((await f.manager.refresh("claude", 100)).result).toBe(result);
      expect(f.execute).toHaveBeenCalledTimes(1);
    },
  );
  it("limits attempts for ten minutes independently per provider", async () => {
    const f = fixture("success", false);
    await f.manager.refresh("claude", 100);
    expect((await f.manager.refresh("claude", 100)).result).toBe("limited");
    await f.manager.refresh("codex", 100);
    expect(f.execute).toHaveBeenCalledTimes(2);
    f.advance();
    await f.manager.refresh("claude", 100);
    expect(f.execute).toHaveBeenCalledTimes(3);
  });
  it.each([
    ["stays unreadable", undefined, undefined, "success"],
    ["becomes a future expiry", undefined, 5000, "success"],
    ["becomes an already-past expiry", undefined, 500, "unchanged"],
    ["does not move when readable", 100, 100, "unchanged"],
    ["disappears when readable before", 100, undefined, "unchanged"],
  ] as const)(
    "judges a clean CLI exit when the expiry %s",
    async (_name, before, after, expected) => {
      const reads: (number | undefined)[] = [before, after];
      const manager = new AutoRefresh({
        settings: async () => ({ autoRefresh: true }),
        expiry: async () => reads.shift(),
        execute: async () => "success",
        now: () => 1000,
      });
      expect((await manager.refresh("codex", before)).result).toBe(expected);
    },
  );
  it("does not launch when disabled", async () => {
    const execute = vi.fn();
    const manager = new AutoRefresh({
      settings: async () => ({ autoRefresh: false }),
      execute,
    });
    expect((await manager.refresh("claude", 100)).result).toBe("disabled");
    expect(execute).not.toHaveBeenCalled();
  });
  it("reuses a newer credential for a late 401", async () => {
    const f = fixture();
    await f.manager.refresh("codex", 100);
    expect((await f.manager.refresh("codex", 100)).result).toBe("success");
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it("uses the X7 successful settings without provider overrides", () => {
    const args = refreshArguments("codex", "empty-temp");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("read-only");
    expect(args).toContain('model_reasoning_effort="low"');
    expect(args.join(" ")).not.toContain("model_providers");
    expect(refreshArguments("claude", "empty-temp")).toContain(
      "claude-haiku-5-5",
    );
    expect(refreshEnvironment().OPENAI_API_KEY).toBeUndefined();
  });
});
