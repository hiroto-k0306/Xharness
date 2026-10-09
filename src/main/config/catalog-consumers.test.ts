import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  overrideCatalogForTest,
  parseCatalog,
  catalogModel,
  catalogAliases,
  resolveRole,
} from "./catalog.js";
import { resolveModel } from "./config.js";
import { toClaudeRequest } from "../providers/claude/convert.js";
import { tmpdir } from "node:os";
import { type ProviderRequest } from "../providers/provider.js";

interface Entry {
  id: string;
  [key: string]: unknown;
}
interface Doc {
  models: Entry[];
  roles: Record<string, unknown> & {
    utility: Record<string, unknown>;
  };
}
const shippedText = readFileSync(
  new URL("../../../catalog/models.yaml", import.meta.url),
  "utf8",
);
/** Swaps the catalog every consumer resolves through, for this test only. */
function useCatalog(change: (doc: Doc) => void) {
  const doc = parse(shippedText) as Doc;
  change(doc);
  overrideCatalogForTest(parseCatalog(stringify(doc)));
}
afterEach(() => overrideCatalogForTest(undefined));
const request = (model: string, effort?: "high"): ProviderRequest => ({
  model,
  system: "",
  messages: [
    { role: "user" as const, content: [{ type: "text" as const, text: "x" }] },
  ],
  tools: [],
  ...(effort ? { reasoning: { effort } } : {}),
});

it("sends Claude effort by the catalog's efforts, not by the model name", () => {
  expect(toClaudeRequest(request("claude-sonnet-5-5", "high"))).toMatchObject({
    output_config: { effort: "high" },
  });
  // Same name, efforts removed in the catalog: accepted and not sent.
  useCatalog((doc) => {
    const sonnet = doc.models.find((m) => m.id === "claude-sonnet-5-5")!;
    delete sonnet.efforts;
    delete sonnet.defaultEffort;
  });
  expect(
    toClaudeRequest(request("claude-sonnet-5-5", "high")),
  ).not.toHaveProperty("output_config");
});
it("supports a newly added Claude model by changing only the catalog", () => {
  expect(() => toClaudeRequest(request("claude-test-9", "high"))).toThrow(
    "Unsupported model effort",
  );
  useCatalog((doc) => {
    doc.models.push({
      provider: "claude",
      id: "claude-test-9",
      alias: "test9",
      enabled: true,
      contextTokens: 50000,
      efforts: { high: "high" },
      defaultEffort: "high",
    });
  });
  expect(toClaudeRequest(request("claude-test-9", "high"))).toMatchObject({
    output_config: { effort: "high" },
  });
  expect(catalogModel("claude-test-9")).toMatchObject({
    id: "claude-test-9",
    contextTokens: 50000,
  });
});
it("passes the connection-test role's model and effort as startup arguments", async () => {
  const { connectionTestStartup } = await import("./catalog.js");
  const { resolveStartup } = await import("./config.js");
  // Shipped Haiku 5.5 uses its catalog default effort.
  expect(connectionTestStartup()).toEqual({
    model: "claude:haiku",
    effort: "medium",
  });
  // Changing only the role changes both arguments, and startup applies them.
  useCatalog((doc) => {
    doc.roles.connectionTest = { model: "claude:sonnet", effort: "low" };
  });
  const args = connectionTestStartup();
  expect(args).toEqual({ model: "claude:sonnet", effort: "low" });
  const started = await resolveStartup({
    home: tmpdir(),
    cliModel: args.model,
    cliEffort: args.effort,
    supported: ["claude", "codex"],
    read: async () => "",
  });
  expect(started.choice).toMatchObject({
    provider: "claude",
    model: "sonnet",
    effort: "low",
  });
  // A role without effort falls back to the model's catalog default.
  useCatalog((doc) => {
    doc.roles.connectionTest = "claude:sonnet";
  });
  expect(connectionTestStartup().effort).toBe("high");
});

it("moves official workflow roles and aliases to the latest generation using only catalog data", () => {
  useCatalog((doc) => {
    const old = doc.models.find((m) => m.id === "claude-haiku-5-5")!;
    doc.models.push({ ...old, id: "claude-haiku-test-next" });
    delete old.alias;
    old.enabled = false;
  });
  expect(resolveRole("question", "claude").id).toBe("claude-haiku-test-next");
  const models = Object.values(catalogAliases());
  expect(resolveModel("claude:haiku", catalogAliases())).toEqual({
    provider: "claude",
    model: "claude-haiku-test-next",
  });
  expect(models).toContain("claude-haiku-test-next");
  expect(models).not.toContain("claude-haiku-5-5");
  expect(models).not.toContain("claude-haiku-4-5-20251001");
  expect(models).not.toContain("claude-haiku-4-5");
});
