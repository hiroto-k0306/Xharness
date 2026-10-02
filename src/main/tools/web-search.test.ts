import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { webSettings, DEFAULT_WEB } from "../config/config.js";
import { type WebSource } from "../core/types.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { type Provider } from "../providers/provider.js";
import {
  hostInDomains,
  searchCandidates,
  webSearchTool,
  type SearchBudget,
} from "./web-search.js";
import { webTools } from "./web.js";
const signal = () => new AbortController().signal;

/** 1回の検索で sources を返す偽プロバイダ。fail なら error を返す */
function searcher(
  id: Provider["id"],
  sources: WebSource[],
  fail = false,
): Provider & { calls: number } {
  const p = {
    id,
    calls: 0,
    models: () => [],
    async *stream() {
      p.calls++;
      if (fail) {
        yield { type: "error" as const, message: "down" };
        return;
      }
      yield {
        type: "message_done" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn" as const,
        message: {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "answer" }],
          meta: { sources, webSearch: { calls: 1 } },
        },
      };
    },
  };
  return p as unknown as Provider & { calls: number };
}
const sources: WebSource[] = [
  { title: "A", url: "https://example.com/a" },
  { title: "A again", url: "https://example.com/a", pageAge: "2026-09-01" },
  { title: "Docs", url: "https://docs.example.com/x" },
  { title: "Other", url: "https://other.test/y" },
  { title: "Deceptive", url: "https://example.com.evil.test/" },
];

describe("WebSearch domains (§22.4)", () => {
  it("validates domain lists", async () => {
    const tool = webSearchTool(() => searcher("claude", []));
    expect(await tool.validate({ query: "q" })).toBeUndefined();
    expect(
      await tool.validate({ query: "q", allowedDomains: ["example.com"] }),
    ).toBeUndefined();
    for (const bad of [
      { query: "q", allowedDomains: ["a.com"], blockedDomains: ["b.com"] },
      { query: "q", allowedDomains: [] },
      { query: "q", allowedDomains: ["https://example.com/"] },
      { query: "q", blockedDomains: ["localhost"] },
      {
        query: "q",
        allowedDomains: Array.from({ length: 21 }, (_, i) => `d${i}.com`),
      },
      { query: "q", extra: 1 },
    ])
      expect(await tool.validate(bad)).toBeDefined();
  });
  it("matches the domain itself and its subdomains only", () => {
    expect(hostInDomains("https://example.com/", ["example.com"])).toBe(true);
    expect(hostInDomains("https://a.example.com/", ["example.com"])).toBe(true);
    expect(hostInDomains("https://example.com.evil/", ["example.com"])).toBe(
      false,
    );
    expect(hostInDomains("https://badexample.com/", ["example.com"])).toBe(
      false,
    );
    expect(hostInDomains("not a url", ["example.com"])).toBe(false);
  });
  it("dedupes by URL, keeps page age and filters allowed / blocked domains", async () => {
    const tool = webSearchTool(() => searcher("claude", sources));
    const all = JSON.parse(
      (await tool.execute({ query: "q" }, signal())).content,
    );
    expect(all.results).toEqual([
      { title: "A", url: "https://example.com/a", pageAge: "2026-09-01" },
      { title: "Docs", url: "https://docs.example.com/x" },
      { title: "Other", url: "https://other.test/y" },
      { title: "Deceptive", url: "https://example.com.evil.test/" },
    ]);
    const allowed = JSON.parse(
      (
        await tool.execute(
          { query: "q", allowedDomains: ["Example.com"] },
          signal(),
        )
      ).content,
    );
    expect(allowed.results.map((r: WebSource) => r.url)).toEqual([
      "https://example.com/a",
      "https://docs.example.com/x",
    ]);
    expect(allowed.allowedDomains).toEqual(["example.com"]);
    const blocked = JSON.parse(
      (
        await tool.execute(
          { query: "q", blockedDomains: ["example.com"] },
          signal(),
        )
      ).content,
    );
    expect(blocked.results.map((r: WebSource) => r.url)).toEqual([
      "https://other.test/y",
      "https://example.com.evil.test/",
    ]);
  });
  it("reads page_age from the real Claude fixture", async () => {
    const provider = new FakeProvider({
      provider: "claude",
      fixturesDir: fileURLToPath(
        new URL("../../../test/fixtures/claude/", import.meta.url),
      ),
    });
    const data = JSON.parse(
      (await webSearchTool(() => provider).execute({ query: "q" }, signal()))
        .content,
    );
    expect(data.results.some((r: { pageAge?: string }) => r.pageAge)).toBe(
      true,
    );
    expect(new Set(data.results.map((r: WebSource) => r.url)).size).toBe(
      data.results.length,
    );
  });
});

describe("WebSearch budget (§22.5)", () => {
  it("stops searching at the limit without an error, sharing one budget", async () => {
    const provider = searcher("claude", sources);
    const budget: SearchBudget = { used: 0, limit: 2 };
    const parent = webSearchTool(() => provider, "live", undefined, { budget });
    const child = webSearchTool(() => provider, "live", undefined, { budget });
    await parent.execute({ query: "1" }, signal());
    await child.execute({ query: "2" }, signal());
    const third = await child.execute({ query: "3" }, signal());
    expect(third.isError).toBeUndefined();
    const data = JSON.parse(third.content);
    expect(data.limitReached).toBe(true);
    expect(data.results).toEqual([]);
    expect(data.message).toContain("2 回");
    expect(provider.calls).toBe(2);
    expect(budget.used).toBe(2);
  });
});

describe("search provider selection (§22.2)", () => {
  const claude = searcher("claude", []);
  const codex = searcher("codex", []);
  it("auto orders by known quota, then by the session provider", () => {
    const ids = (ps: Provider[]) => ps.map((p) => p.id);
    expect(
      ids(searchCandidates([claude, codex], "auto", "codex", {}, false)),
    ).toEqual(["codex", "claude"]);
    expect(
      ids(
        searchCandidates(
          [claude, codex],
          "auto",
          "claude",
          { claude: 90, codex: 10 },
          false,
        ),
      ),
    ).toEqual(["codex", "claude"]);
    expect(
      ids(
        searchCandidates(
          [claude, codex],
          "auto",
          "claude",
          { claude: 90 },
          false,
        ),
      ),
    ).toEqual(["claude", "codex"]);
  });
  it("a fixed provider uses only that provider, and disabled Codex is never used", () => {
    expect(
      searchCandidates([claude, codex], "claude", "codex", {}, false).map(
        (p) => p.id,
      ),
    ).toEqual(["claude"]);
    expect(
      searchCandidates([claude, codex], "codex", "codex", {}, true),
    ).toEqual([]);
    expect(
      searchCandidates([claude, codex], "auto", "codex", {}, true).map(
        (p) => p.id,
      ),
    ).toEqual(["claude"]);
  });
  it("auto falls back to the other provider when the first search fails", async () => {
    const broken = searcher("codex", [], true);
    const working = searcher("claude", sources);
    const tools = new Map(
      webTools(() => broken, "live", false, undefined, {
        providers: () => [broken, working],
      }),
    );
    const out = await tools.get("WebSearch")!.execute({ query: "q" }, signal());
    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.content).provider).toBe("claude");
    expect(broken.calls).toBe(1);
    expect(working.calls).toBe(1);
  });
  it("a fixed provider does not fall back and reports an error", async () => {
    const broken = searcher("codex", [], true);
    const working = searcher("claude", sources);
    const tools = new Map(
      webTools(() => broken, "live", false, undefined, {
        settings: { searchProvider: "codex" },
        providers: () => [broken, working],
      }),
    );
    const out = await tools.get("WebSearch")!.execute({ query: "q" }, signal());
    expect(out.isError).toBe(true);
    expect(working.calls).toBe(0);
  });
});

describe("web settings (§22.6)", () => {
  it("applies fetch maxChars and cacheMinutes from settings", async () => {
    let now = 0;
    const pages: string[] = [];
    const provider = {
      id: "claude",
      models: () => [],
      async *stream(request: { messages: { content: { text: string }[] }[] }) {
        pages.push(JSON.parse(request.messages[0]!.content[0]!.text).page);
        yield {
          type: "message_done" as const,
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "end_turn" as const,
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "summary" }],
          },
        };
      },
    } as unknown as Provider;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response("x".repeat(5000), {
          headers: { "content-type": "text/plain" },
        }),
    );
    const tools = new Map(
      webTools(() => provider, "live", false, undefined, {
        settings: { fetch: { maxChars: 1000, cacheMinutes: 1 } },
        fetch: {
          lookup: async () => [{ address: "93.184.215.14", family: 4 }],
          fetcher,
          now: () => now,
        },
      }),
    );
    const input = { url: "https://example.com/", prompt: "p" };
    await tools.get("WebFetch")!.execute(input, signal());
    expect(pages[0]!.length).toBeLessThanOrEqual(1100);
    expect(pages[0]!.length).toBeLessThan(5000);
    now = 59_000;
    await tools.get("WebFetch")!.execute(input, signal());
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 61_000;
    await tools.get("WebFetch")!.execute(input, signal());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("keeps defaults and warns on invalid values", () => {
    const warnings: string[] = [];
    const web = webSettings(
      {
        searchProvider: "bing",
        codexSearchMode: "off",
        maxSearchesPerSession: 0,
        fetch: { maxChars: 10, cacheMinutes: -1 },
      },
      warnings,
    );
    expect(web).toEqual(DEFAULT_WEB);
    expect(warnings).toHaveLength(5);
  });
  it("maps legacy searchMode and accepts valid values", () => {
    expect(webSettings({ searchMode: "cached" }).codexSearchMode).toBe(
      "cached",
    );
    const web = webSettings({
      searchProvider: "claude",
      codexSearchMode: "disabled",
      maxSearchesPerSession: 5,
      fetch: { maxChars: 5000, cacheMinutes: 60 },
    });
    expect(web).toMatchObject({
      searchProvider: "claude",
      codexSearchMode: "disabled",
      maxSearchesPerSession: 5,
      fetch: { maxChars: 5000, cacheMinutes: 60 },
    });
  });
});

describe("no usable search provider", () => {
  it("explains the settings and does not use the search budget", async () => {
    const codex = searcher("codex", sources);
    const budget: SearchBudget = { used: 0, limit: 5 };
    const tools = new Map(
      webTools(() => codex, "live", false, undefined, {
        settings: { searchProvider: "codex", codexSearchMode: "disabled" },
        providers: () => [codex],
        budget,
      }),
    );
    const out = await tools.get("WebSearch")!.execute({ query: "q" }, signal());
    expect(out.isError).toBe(true);
    expect(out.content).toContain("web.codexSearchMode");
    expect(budget.used).toBe(0);
    expect(codex.calls).toBe(0);
  });
});
