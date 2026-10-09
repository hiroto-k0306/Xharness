import { afterEach, expect, it } from "vitest";
import {
  catalogAliases,
  catalogLookup,
  loadCatalog,
  normalizeModelPolicy,
  overrideCatalogForTest,
  resolveModelPolicy,
  type Catalog,
} from "./catalog.js";
import { loadMainConfig, resolveStartup } from "./config.js";

afterEach(() => overrideCatalogForTest(undefined));
const copy = (): Catalog => structuredClone(loadCatalog());

it("keeps alias and effort stable while each use resolves the current generation", () => {
  const before = copy();
  const policy = normalizeModelPolicy("codex:sol", "low", before);
  const next = structuredClone(before);
  const old = next.models.find((m) => m.alias === "sol")!;
  next.models.push({ ...old, id: "explicit-next-id", historicalIds: [old.id] });
  delete old.alias;
  old.enabled = false;
  overrideCatalogForTest(next);
  expect(
    resolveModelPolicy(`${policy.provider}:${policy.model}`, policy.effort),
  ).toMatchObject({
    model: "sol",
    effort: "low",
    id: "explicit-next-id",
  });
  expect(policy).toEqual({ provider: "codex", model: "sol", effort: "low" });
  expect(normalizeModelPolicy(old.id, "low", next)).toEqual(policy);
  // A concrete old record still identifies its original generation.
  expect(catalogLookup(old.id, next)?.id).toBe(old.id);
});

it("migrates only declared historical IDs and rejects guessed families", () => {
  expect(normalizeModelPolicy("claude-haiku-4-5", "high")).toEqual({
    provider: "claude",
    model: "haiku",
    effort: "high",
  });
  expect(() =>
    normalizeModelPolicy("claude-haiku-unlisted-generation", "high"),
  ).toThrow(/明示されたalias対応/);
  expect(() => normalizeModelPolicy("gpt-5.5", "high")).toThrow(
    /明示されたalias対応/,
  );
  expect(() => normalizeModelPolicy("claude:gpt-6.1-sol", "high")).toThrow();
});

it("rejects ambiguous aliases or historical mappings instead of selecting the first", () => {
  const catalog = copy();
  const sol = catalog.models.find((m) => m.alias === "sol")!;
  catalog.models.push({ ...sol, id: "duplicate-id" });
  expect(() => normalizeModelPolicy("codex:sol", "high", catalog)).toThrow(
    /競合/,
  );
  expect(() => catalogAliases(catalog)).toThrow(/競合/);
  expect(() => normalizeModelPolicy("gpt-6-sol", "high", catalog)).toThrow(
    /競合/,
  );
});

it("rejects alias overrides, disabled targets and unsupported efforts without fallback", () => {
  const catalog = copy();
  expect(() =>
    resolveModelPolicy("claude:opus", "high", catalog, {
      opus: "claude-sonnet-5-5",
    }),
  ).toThrow(/競合/);
  const opus = catalog.models.find((m) => m.alias === "opus")!;
  delete opus.efforts!.high;
  expect(() => resolveModelPolicy("claude:opus", "high", catalog)).toThrow(
    /対応していません/,
  );
  expect(() => resolveModelPolicy("claude:opus", "turbo", catalog)).toThrow(
    /effort/,
  );
  opus.enabled = false;
  expect(() => resolveModelPolicy("claude:opus", "low", catalog)).toThrow(
    /無効.*切り替えていません/,
  );
});

it("loads unavailable settings for history access but refuses startup; explicit CLI selection wins", async () => {
  const read = async () => "main: {model: codex:unlisted, effort: turbo}";
  const config = await loadMainConfig("unused", read);
  expect(config.choice).toEqual({
    provider: "codex",
    model: "unlisted",
    effort: "turbo",
  });
  expect(config.warnings.length).toBeGreaterThan(0);
  await expect(
    resolveStartup({ home: "unused", read, supported: ["claude", "codex"] }),
  ).rejects.toThrow();
  expect(
    (
      await resolveStartup({
        home: "unused",
        read,
        cliModel: "claude:sonnet",
        cliEffort: "low",
        supported: ["claude"],
      })
    ).choice,
  ).toEqual({ provider: "claude", model: "sonnet", effort: "low" });
});

it("loads choices as aliases without rewriting configuration or dropping effort", async () => {
  const config = await loadMainConfig(
    "unused",
    async () => "main: {model: gpt-6-sol, effort: max}",
  );
  expect(config.choice).toEqual({
    provider: "codex",
    model: "sol",
    effort: "max",
  });
});
