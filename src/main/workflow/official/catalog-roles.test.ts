import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  catalogVersion,
  loadCatalog,
  overrideCatalogForTest,
  parseCatalog,
} from "../../config/catalog.js";
import { OfficialWorkflowService, resolvePlannerChoice } from "./service.js";
import type { ModelCandidate, OfficialAgent } from "./contracts.js";
import { digest } from "./runtime.js";
import {
  createSyntheticWorkspace,
  fixturePlan,
  fixtureTest,
} from "./fixtures.js";
import { gitWorkspace } from "./workspace.js";

interface Entry {
  id: string;
  [key: string]: unknown;
}
interface Doc {
  models: Entry[];
  roles: Record<string, unknown> & { question: Record<string, unknown> };
}
const shippedText = readFileSync(
  new URL("../../../../catalog/models.yaml", import.meta.url),
  "utf8",
);
function useCatalog(change: (doc: Doc) => void) {
  const doc = parse(shippedText) as Doc;
  change(doc);
  overrideCatalogForTest(parseCatalog(stringify(doc)));
}
const homes: string[] = [];
const services: OfficialWorkflowService[] = [];
afterEach(async () => {
  overrideCatalogForTest(undefined);
  for (const s of services.splice(0)) await s.close();
  for (const h of homes.splice(0))
    await rm(h, { recursive: true, force: true, maxRetries: 5 });
});
const candidate = (
  provider: "claude" | "codex",
  model: string,
): ModelCandidate => ({
  provider,
  model,
  resolvedModel: provider === "claude" ? model : undefined,
  efforts: [null, "low", "high"],
  available: true,
  quotaAllowed: true,
  capabilitySource:
    provider === "claude" ? "official-sdk" : "official-app-server",
});
function agent(provider: "claude" | "codex", models: string[]) {
  const ran: { model: string; prompt: string }[] = [];
  const value: OfficialAgent = {
    provider,
    discover: async () => models.map((m) => candidate(provider, m)),
    run: async (request) => {
      ran.push({ model: request.model.model, prompt: request.prompt });
      return {
        status: "completed",
        dispatched: true,
        output: { summary: "not a plan" },
        observedModels: [request.model.model],
        usage: null,
        elapsedMs: 1,
      };
    },
  };
  return { agent: value, ran };
}
async function service(
  claude: ReturnType<typeof agent>,
  codex: ReturnType<typeof agent>,
) {
  const home = await mkdtemp(join(tmpdir(), "xh-catalog-roles-"));
  homes.push(home);
  const instance = new OfficialWorkflowService({
    home,
    fake: false,
    codexPath: "C:/configured/codex.exe",
    agents: { claude: claude.agent, codex: codex.agent },
  });
  services.push(instance);
  return { instance, home };
}
const claudeIds = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-haiku-4-5-20251001",
];
const codexIds = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"];

it("refuses a new Haiku question when only Haiku 4.5 is offered", async () => {
  const claude = agent("claude", ["claude-haiku-4-5-20251001"]);
  const { instance } = await service(claude, agent("codex", codexIds));
  const view = await instance.command({
    action: "chat",
    provider: "claude",
    text: "質問",
  });
  expect(view.error).toMatch(/claude-haiku-5-5.*一覧にありません/);
  expect(claude.ran).toEqual([]);
});

it("displays and sends the question model chosen by the catalog role", async () => {
  useCatalog((doc) => {
    doc.roles.question.codex = "codex:sol";
  });
  const codex = agent("codex", codexIds);
  const { instance } = await service(agent("claude", claudeIds), codex);
  const view = await instance.command({ action: "list" });
  // No effort in the role: the model's catalog defaultEffort is used and shown.
  expect(view.questionModels?.codex).toEqual({
    id: "gpt-6.1-sol",
    effort: "high",
  });
  await instance.command({ action: "chat", provider: "codex", text: "質問" });
  for (let i = 0; i < 200 && !codex.ran.length; i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(codex.ran.map((r) => r.model)).toEqual(["gpt-6.1-sol"]);
});

it("stops a question whose catalog model is retired, and shows why", async () => {
  useCatalog((doc) => {
    doc.models.find((m) => m.id === "gpt-6-luna")!.retiresAt = "2026-01-01";
  });
  const codex = agent("codex", codexIds);
  const { instance } = await service(agent("claude", claudeIds), codex);
  const listed = await instance.command({ action: "list" });
  expect(listed.questionModels?.codex).toMatchObject({
    error: expect.stringMatching(/提供終了/),
  });
  const view = await instance.command({
    action: "chat",
    provider: "codex",
    text: "質問",
  });
  expect(view.error).toMatch(/^質問先のモデルを決められません：.*提供終了/);
  expect(codex.ran).toEqual([]);
});

it("records the selection key, provider, sent ID, effort and catalog version at start", () => {
  const models = [candidate("codex", "gpt-6.1-sol")];
  const chosen = resolvePlannerChoice(
    { model: "codex:sol", effort: "high" },
    models,
  );
  expect(chosen).toEqual({
    provider: "codex",
    model: "gpt-6.1-sol",
    effort: "high",
    selectedAs: "codex:sol",
    catalog: catalogVersion(loadCatalog()),
  });
  // Saved evidence stays unchanged; a new resolution uses the current catalog.
  const savedChoice = JSON.stringify(chosen);
  useCatalog((doc) => {
    doc.models.find((m) => m.id === "gpt-6.1-sol")!.displayName = "changed";
  });
  expect(resolvePlannerChoice(chosen, models).catalog).toEqual(
    catalogVersion(loadCatalog()),
  );
  expect(resolvePlannerChoice(chosen, models).catalog).not.toEqual(
    chosen.catalog,
  );
  expect(JSON.stringify(chosen)).toBe(savedChoice);
  // A retired planner model stops; no other model is chosen.
  useCatalog((doc) => {
    doc.models.find((m) => m.id === "gpt-6.1-sol")!.enabled = false;
  });
  expect(() => resolvePlannerChoice(chosen, models)).toThrow(
    /モデル「gpt-6.1-sol」.*無効.*別のモデルへは切り替えていません/,
  );
});

it("offers the planner only models both listed by the connection and enabled in the catalog", async () => {
  useCatalog((doc) => {
    doc.models.find((m) => m.id === "gpt-6-astra")!.enabled = false;
  });
  const claude = agent("claude", claudeIds);
  const { instance } = await service(
    claude,
    agent("codex", [...codexIds, "gpt-6-sol"]),
  );
  await instance.command({
    action: "create",
    provider: "codex",
    planner: { model: "claude:opus", effort: "high" },
  });
  for (let i = 0; i < 300 && !claude.ran.length; i++)
    await new Promise((r) => setTimeout(r, 10));
  const offered = (
    JSON.parse(claude.ran[0]!.prompt) as { availableModels: ModelCandidate[] }
  ).availableModels.map((m) => m.model);
  expect(offered).toContain("gpt-6.1-sol");
  expect(offered).not.toContain("claude-haiku-4-5-20251001");
  expect(offered).not.toContain("gpt-6-astra"); // disabled in the catalog
  expect(offered).not.toContain("gpt-6-sol"); // listed by the connection, disabled in the catalog
});

it("stops resuming a record whose recorded model the catalog retired", async () => {
  const { instance, home } = await service(
    agent("claude", claudeIds),
    agent("codex", codexIds),
  );
  await instance.close();
  const id = randomUUID(),
    directory = join(home, "official-workflows", id);
  await mkdir(directory, { recursive: true });
  const cwd = await createSyntheticWorkspace("workspace-", directory);
  const head = (
    await gitWorkspace(cwd, (x) => x).inspect(new AbortController().signal)
  ).head;
  const plan = fixturePlan("claude");
  plan.tasks[0]!.assignee.model = "claude-sonnet-5-5";
  plan.tasks[0]!.reviewer = {
    provider: "codex",
    model: "gpt-6-luna",
    effort: "low",
    reason: "other company",
  };
  await writeFile(
    join(directory, "workflow.json"),
    JSON.stringify({
      version: 1,
      simulated: false,
      id,
      goal: "Correct addition without modifying the test.",
      cwd,
      startedAt: new Date().toISOString(),
      status: "interrupted",
      next: "implement",
      base: head,
      head,
      correctionRounds: 0,
      calls: [],
      tools: [],
      checks: [],
      reviews: [],
      commits: [],
      plan,
      approvedDigest: digest(plan),
      executionDigest: digest({
        goal: "Correct addition without modifying the test.",
        files: ["add.mjs"],
        tests: [fixtureTest()],
        integrationTests: [],
      }),
      planner: {
        provider: "claude",
        model: "claude-opus-5-5",
        effort: "high",
        selectedAs: "claude:opus",
      },
    }),
  );
  useCatalog((doc) => {
    doc.models.find((m) => m.id === "gpt-6-luna")!.retiresAt = "2026-01-01";
  });
  const claude = agent("claude", claudeIds),
    codex = agent("codex", codexIds);
  const restarted = new OfficialWorkflowService({
    home,
    fake: false,
    codexPath: "C:/fixture/codex.exe",
    agents: { claude: claude.agent, codex: codex.agent },
  });
  services.push(restarted);
  const view = await restarted.command({ action: "resume", id });
  let stopped = view.records.find((r) => r.record.id === id)?.record;
  for (let i = 0; i < 200 && stopped?.status !== "failed"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    stopped = (await restarted.command({ action: "list" })).records.find(
      (r) => r.record.id === id,
    )?.record;
  }
  expect(stopped?.status).toBe("failed");
  expect(view.error ?? stopped?.error).toMatch(
    /^モデル「gpt-6-luna」は提供終了.*別のモデルへは切り替えていません/,
  );
  expect(stopped?.plan).toEqual(plan);
  expect(stopped?.approvedDigest).toBe(digest(plan));
  expect(stopped?.calls).toEqual([]);
  expect(claude.ran).toEqual([]);
  expect(codex.ran).toEqual([]);
});
