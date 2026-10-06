import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  catalogAliases,
  catalogLookup,
  catalogUnavailableReason,
  catalogVersion,
  loadCatalog,
  parseCatalog,
  resolveRole,
  roleEffort,
  sendsEffort,
  type Catalog,
} from "./catalog.js";
import { DEFAULT_ALIASES, DEFAULT_MAIN, defaultFallback } from "./config.js";

const shippedText = readFileSync(
  new URL("../../../catalog/models.yaml", import.meta.url),
  "utf8",
);
interface Entry {
  id: string;
  enabled?: boolean;
  efforts?: Record<string, string>;
  defaultEffort?: string;
  retiresAt?: string;
  [key: string]: unknown;
}
interface Doc {
  version: number;
  models: Entry[];
  retired: { id: string; at: string }[];
  roles: {
    main: unknown;
    question: Record<string, unknown>;
    reviewer: Record<string, unknown>;
    [key: string]: unknown;
  };
}
/** A catalog derived from the shipped one, changed only through its data. */
function swapped(change: (doc: Doc) => void): Catalog {
  const doc = parse(shippedText) as Doc;
  change(doc);
  return parseCatalog(stringify(doc));
}
const model = (doc: Doc, id: string) =>
  (doc.models as Entry[]).find((m) => m.id === id)!;

it("resolves every shipped role to an enabled, current catalog model", () => {
  const catalog = loadCatalog();
  const roles: [Parameters<typeof resolveRole>[0], string?][] = [
    ["main"],
    ["explorer"],
    ["connectionTest"],
    ["fallback", "claude"],
    ["fallback", "codex"],
    ["reviewer", "ofClaude"],
    ["reviewer", "ofCodex"],
    ["utility", "claude"],
    ["utility", "codex"],
    ["question", "claude"],
    ["question", "codex"],
    ["compaction", "codex"],
    ["authRefresh", "claude"],
    ["authRefresh", "codex"],
    ["officialLegacyPlanner"],
    ["officialLegacyReviewer", "claude"],
    ["officialLegacyReviewer", "codex"],
  ];
  for (const [role, sub] of roles) {
    const resolved = resolveRole(role, sub, catalog);
    expect(catalogUnavailableReason(resolved.id, catalog)).toBeUndefined();
    // Per-company roles use that company's model (fallback deliberately crosses over).
    if ((sub === "claude" || sub === "codex") && role !== "fallback")
      expect(resolved.provider).toBe(sub);
  }
  // Config defaults come from the same resolution.
  expect(DEFAULT_MAIN).toEqual({
    model: resolveRole("main", undefined, catalog).key,
    effort: roleEffort(resolveRole("main", undefined, catalog)),
  });
  expect(defaultFallback(catalog)).toEqual({
    claude: resolveRole("fallback", "claude", catalog).key,
    codex: resolveRole("fallback", "codex", catalog).key,
  });
  expect(DEFAULT_ALIASES).toEqual(catalogAliases(catalog));
});

it("adds a model by changing only the catalog", () => {
  const catalog = swapped((doc) => {
    doc.models.push({
      provider: "codex",
      id: "gpt-test-nova",
      alias: "nova",
      enabled: true,
      contextTokens: 100000,
      efforts: { low: "low", high: "high" },
      defaultEffort: "low",
    });
    doc.roles.question.codex = "codex:nova";
  });
  expect(catalogAliases(catalog).nova).toBe("gpt-test-nova");
  expect(catalogLookup("codex:nova", catalog)?.id).toBe("gpt-test-nova");
  expect(resolveRole("question", "codex", catalog)).toMatchObject({
    key: "codex:nova",
    provider: "codex",
    id: "gpt-test-nova",
  });
});

it("changes a role assignment by changing only the catalog", () => {
  const catalog = swapped((doc) => {
    doc.roles.main = "codex:sol";
    doc.roles.reviewer.ofCodex = { model: "claude:opus", effort: "max" };
  });
  expect(resolveRole("main", undefined, catalog)).toMatchObject({
    provider: "codex",
    id: "gpt-6.1-sol",
  });
  expect(roleEffort(resolveRole("main", undefined, catalog))).toBe("high");
  expect(resolveRole("reviewer", "ofCodex", catalog)).toMatchObject({
    id: "claude-opus-5-5",
    effort: "max",
  });
});

it("changes supported and default efforts by changing only the catalog", () => {
  const lowRemoved = swapped((doc) => {
    delete model(doc, "gpt-6-luna").efforts!.low;
  });
  // A role that names an effort the model no longer supports stops with a reason.
  expect(() => resolveRole("utility", "codex", lowRemoved)).toThrow(
    /effort「low」はモデル「gpt-6-luna」が対応していません/,
  );
  const defaultChanged = swapped((doc) => {
    model(doc, "claude-opus-5-5").defaultEffort = "max";
  });
  expect(roleEffort(resolveRole("main", undefined, defaultChanged))).toBe(
    "max",
  );
  // No efforts declared: effort is never sent (capability from the catalog, not the name).
  const noEfforts = swapped((doc) => {
    delete model(doc, "claude-sonnet-5-5").efforts;
    delete model(doc, "claude-sonnet-5-5").defaultEffort;
  });
  const sonnet = resolveRole("explorer", undefined, noEfforts);
  expect(sendsEffort(sonnet.model)).toBe(false);
  expect(roleEffort(sonnet)).toBeUndefined();
});

it.each([
  [
    "disabled",
    (doc: Doc) => {
      model(doc, "gpt-6-luna").enabled = false;
    },
    /モデルカタログで無効です/,
  ],
  [
    "retired by date",
    (doc: Doc) => {
      model(doc, "gpt-6-luna").retiresAt = "2026-01-01";
    },
    /提供終了/,
  ],
  [
    "listed as retired",
    (doc: Doc) => {
      doc.retired.push({ id: "gpt-6-luna", at: "2026-01-01" });
    },
    /提供終了/,
  ],
  [
    "removed",
    (doc: Doc) => {
      doc.models = doc.models.filter((m: Entry) => m.id !== "gpt-6-luna");
    },
    /モデルカタログにありません/,
  ],
] as const)(
  "stops a role whose model is %s instead of substituting another model",
  (_label, change, reason) => {
    const catalog = swapped(change);
    expect(() => resolveRole("question", "codex", catalog)).toThrow(reason);
    expect(() => resolveRole("question", "codex", catalog)).toThrow(
      /別のモデルへは切り替えていません|モデルカタログにありません/,
    );
  },
);

it("reports a different catalog version when the catalog text changes", () => {
  const changed = swapped((doc) => {
    doc.version = 9;
  });
  expect(catalogVersion(changed).version).toBe(9);
  expect(catalogVersion(changed).digest).not.toBe(
    catalogVersion(loadCatalog()).digest,
  );
});
