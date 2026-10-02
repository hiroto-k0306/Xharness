import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { webFetchTool } from "./web-fetch.js";
import { webTools } from "./web.js";
import { ClaudeAdapter } from "../providers/claude/adapter.js";
import { CodexAdapter } from "../providers/codex/adapter.js";
import { decidePermission, grantFor } from "../core/permissions.js";
const signal = () => new AbortController().signal;
it("returns summaries only, upgrades HTTP, and caches by URL and prompt for fifteen minutes", async () => {
  let now = 0;
  const summarize = vi.fn().mockResolvedValue("safe summary");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () =>
        new Response(
          "<nav>ignore</nav><h1>Page</h1><p>RAW PAGE</p><script>evil</script>",
          { headers: { "content-type": "text/html" } },
        ),
    );
  const tool = webFetchTool({
    lookup: async () => [{ address: "93.184.215.14", family: 4 }],
    fetcher,
    summarize,
    now: () => now,
  });
  const input = { url: "http://example.com/", prompt: "extract facts" };
  expect(await tool.validate(input)).toBeUndefined();
  expect(await tool.validate({ url: input.url })).toBeDefined();
  const first = await tool.execute(input, signal());
  expect(first.content).toContain("safe summary");
  expect(first.content).not.toContain("RAW PAGE");
  expect(String(fetcher.mock.calls[0]![0])).toBe("https://example.com/");
  expect(summarize.mock.calls[0]![0]).toContain("# Page");
  expect(summarize.mock.calls[0]![0]).not.toMatch(/evil|ignore/);
  await tool.execute(input, signal());
  expect(fetcher).toHaveBeenCalledTimes(1);
  now = 900001;
  await tool.execute(input, signal());
  expect(fetcher).toHaveBeenCalledTimes(2);
  await tool.execute({ ...input, prompt: "different" }, signal());
  expect(summarize).toHaveBeenCalledTimes(3);
});
it("does not summarize or request a redirect destination and never returns raw text on a summary failure", async () => {
  const summarize = vi.fn().mockRejectedValue(new Error("failure"));
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://other.example/" },
      }),
    );
  const tool = webFetchTool({
    lookup: async () => [{ address: "93.184.215.14", family: 4 }],
    fetcher,
    summarize,
  });
  const output = await tool.execute(
    { url: "https://example.com/", prompt: "q" },
    signal(),
  );
  expect(output.content).toContain("other.example");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(summarize).not.toHaveBeenCalled();
  fetcher.mockResolvedValue(
    new Response("RAW_SECRET_PAGE", {
      headers: { "content-type": "text/plain" },
    }),
  );
  await expect(
    tool.execute({ url: "https://example.com/", prompt: "q" }, signal()),
  ).rejects.toThrow();
});
it.each(["claude", "codex"] as const)(
  "replays the real %s web summary with no tools or parent history",
  async (id) => {
    const sse = await readFile(
      `test/fixtures/stabilize/${id}-web-summary.sse`,
      "utf8",
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(sse));
    const provider =
      id === "claude"
        ? new ClaudeAdapter({ fetcher, getAccessToken: async () => "test" })
        : new CodexAdapter({
            fetcher,
            getCredentials: async () => ({
              accessToken: "test",
              accountId: "test",
            }),
          });
    // The page fetch itself is isolated by a mocked global fetch, adapter traffic uses its own injected fetcher.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("Example Domain", {
            headers: { "content-type": "text/plain" },
          }),
        ),
    );
    try {
      const tool = new Map(webTools(() => provider, "live", false)).get(
        "WebFetch",
      )!;
      const out = await tool.execute(
        { url: "https://example.com/", prompt: "purpose" },
        signal(),
      );
      expect(JSON.parse(out.content).summary).toMatch(
        /documentation|placeholder/i,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
it("matches exact domain grants without allowing sibling, subdomain or deceptive hosts", async () => {
  const call = {
    id: "x",
    name: "WebFetch",
    input: { url: "https://example.com/a", prompt: "q" },
  };
  const rule = grantFor(call);
  expect(rule.pattern).toBe("domain:example.com");
  for (const [url, result] of [
    ["http://example.com/b", "allow"],
    ["https://sub.example.com/", "ask"],
    ["https://example.com.evil/", "ask"],
  ])
    expect(
      await decidePermission(
        { ...call, input: { url, prompt: "q" } },
        { mode: "default", rules: [rule] },
        process.cwd(),
      ),
    ).toBe(result);
});
