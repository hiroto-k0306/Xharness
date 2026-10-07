import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { overrideCatalogForTest, parseCatalog } from "../../config/catalog.js";
import { OfficialWorkflowService, resolvePlannerChoice } from "./service.js";
import { impliedRecordModels } from "./record-compat.js";
import { digest, type WorkflowRecord } from "./runtime.js";
import {
  createSyntheticWorkspace,
  fixturePlan,
  fixtureTest,
} from "./fixtures.js";
import { gitWorkspace } from "./workspace.js";
import type {
  AgentRequest,
  ModelCandidate,
  OfficialAgent,
} from "./contracts.js";
import { webSummaryRequest } from "../../tools/web.js";
import { webSearchTool } from "../../tools/web-search.js";
import { toClaudeRequest } from "../../providers/claude/convert.js";
import type { Provider, ProviderRequest } from "../../providers/provider.js";

interface Entry {
  id: string;
  [key: string]: unknown;
}
interface Doc {
  models: Entry[];
  roles: Record<string, unknown> & {
    utility: Record<string, unknown>;
    question: Record<string, unknown>;
  };
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
/** A new alias generation: the aliases move to new IDs; the old IDs stay listed. */
function newAliasGeneration(doc: Doc) {
  for (const [id, alias, next] of [
    ["claude-opus-5-5", "opus", "claude-opus-6-0"],
    ["gpt-6-luna", "luna", "gpt-7-luna"],
    ["gpt-6.1-sol", "sol", "gpt-7-sol"],
  ] as const) {
    const old = doc.models.find((m) => m.id === id)!;
    old.alias = `${alias}-previous`;
    doc.models.push({ ...old, id: next, alias });
  }
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
  efforts: [null, "low", "medium", "high"],
  available: true,
  quotaAllowed: true,
  capabilitySource:
    provider === "claude" ? "official-sdk" : "official-app-server",
});
function agent(provider: "claude" | "codex", models: string[]) {
  const requests: AgentRequest[] = [];
  const value: OfficialAgent = {
    provider,
    discover: async () => models.map((m) => candidate(provider, m)),
    run: async (request) => {
      requests.push(request);
      let output: unknown = { summary: "ok" };
      if (request.phase === "implement" || request.phase === "fix")
        await writeFile(
          join(request.cwd, "add.mjs"),
          "export const add = (a, b) => a + b;\n",
        );
      if (request.phase === "review") {
        const prompt = JSON.parse(request.prompt) as {
          base: string;
          head: string;
        };
        output = { base: prompt.base, head: prompt.head, findings: [] };
      }
      return {
        status: "completed",
        dispatched: true,
        output,
        observedModels: [request.model.model],
        usage: null,
        elapsedMs: 1,
      };
    },
  };
  return { agent: value, requests };
}
async function service(claudeIds: string[], codexIds: string[]) {
  const home = await mkdtemp(join(tmpdir(), "xh-catalog-compat-"));
  homes.push(home);
  const claude = agent("claude", claudeIds),
    codex = agent("codex", codexIds);
  const instance = new OfficialWorkflowService({
    home,
    fake: false,
    codexPath: "C:/configured/codex.exe",
    agents: { claude: claude.agent, codex: codex.agent },
  });
  services.push(instance);
  return { instance, home, claude, codex };
}
/** A saved, resumable record (plan approved, waiting to implement). */
async function savedRecord(
  home: string,
  shape: (record: WorkflowRecord) => void,
): Promise<{ id: string; file: string }> {
  const id = randomUUID(),
    directory = join(home, "official-workflows", id);
  await mkdir(directory, { recursive: true });
  const cwd = await createSyntheticWorkspace("workspace-", directory);
  const head = (
    await gitWorkspace(cwd, (x) => x).inspect(new AbortController().signal)
  ).head;
  const goal = "Correct addition without modifying the test.";
  const plan = fixturePlan("claude");
  plan.tasks[0]!.assignee.model = "claude-haiku-4-5-20251001";
  const record: WorkflowRecord = {
    version: 1,
    simulated: false,
    id,
    goal,
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
    executionDigest: digest({
      goal,
      files: ["add.mjs"],
      tests: [fixtureTest()],
      integrationTests: [],
    }),
  };
  shape(record);
  record.approvedDigest = digest(record.plan);
  const file = join(directory, "workflow.json");
  await writeFile(file, JSON.stringify(record));
  return { id, file };
}

it("keeps a legacy record's implied models after an alias generation update", async () => {
  const { instance, home } = await service([], []);
  await instance.close();
  const { id, file } = await savedRecord(home, (r) => {
    delete r.plan!.tasks[0]!.reviewer; // legacy: no recorded reviewer or planner
  });
  const before = await readFile(file, "utf8");
  useCatalog(newAliasGeneration);
  const record = JSON.parse(before) as WorkflowRecord;
  // Fixed per record format, not the current aliases (opus/luna now point elsewhere).
  expect(impliedRecordModels(record)).toEqual({
    reviewers: {
      claude: { model: "claude-opus-5-5", effort: "high" },
      codex: { model: "gpt-6-luna", effort: "low" },
    },
  });
  // Loading never rewrites the stored record.
  const claude = agent("claude", [
      "claude-opus-5-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-6-0",
    ]),
    codex = agent("codex", ["gpt-6-luna", "gpt-7-luna"]);
  const restarted = new OfficialWorkflowService({
    home,
    fake: false,
    codexPath: "C:/configured/codex.exe",
    agents: { claude: claude.agent, codex: codex.agent },
  });
  services.push(restarted);
  await restarted.command({ action: "list" });
  expect(await readFile(file, "utf8")).toBe(before);
  // Resume runs with the recorded implementer and the fixed v1 reviewer.
  const view = await restarted.command({ action: "resume", id });
  expect(view.error).toBeUndefined();
  const done = await finished(restarted, id);
  expect(done.status).toBe("completed");
  expect(claude.requests.map((r) => [r.phase, r.model.model])).toEqual([
    ["implement", "claude-haiku-4-5-20251001"],
  ]);
  expect(codex.requests.map((r) => [r.phase, r.model.model, r.effort])).toEqual(
    [["review", "gpt-6-luna", "low"]],
  );
  // An unknown record format is not guessed.
  expect(() => impliedRecordModels({ ...record, version: 99 as 1 })).toThrow(
    /記録形式v99.*推測では置き換えません/,
  );
});

it("starts a new task while the legacy-record models are retired", async () => {
  useCatalog((doc) => {
    for (const id of ["claude-opus-5-5", "gpt-6-luna"])
      doc.models.find((m) => m.id === id)!.retiresAt = "2026-01-01";
  });
  const { instance, codex } = await service(
    ["claude-sonnet-5-5", "claude-haiku-4-5-20251001"],
    ["gpt-6.1-sol", "gpt-6-astra"],
  );
  const view = await instance.command({
    action: "create",
    provider: "claude",
    planner: { model: "codex:sol", effort: "high" },
  });
  expect(view.error).toBeUndefined();
  for (let i = 0; i < 300 && !codex.requests.length; i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(codex.requests[0]).toMatchObject({
    phase: "plan",
    model: { model: "gpt-6.1-sol" },
    effort: "high",
  });
});

it("sends the role effort, changed only in the catalog, in each request", async () => {
  useCatalog((doc) => {
    doc.roles.utility.codex = { model: "codex:luna", effort: "medium" };
    doc.roles.question.codex = { model: "codex:luna", effort: "high" };
    doc.models.find((m) => m.id === "claude-opus-5-5")!.defaultEffort = "max";
  });
  // Web summary
  expect(webSummaryRequest("codex", "q", "p").reasoning).toEqual({
    effort: "medium",
  });
  expect(webSummaryRequest("claude", "q", "p")).not.toHaveProperty("reasoning");
  // Web search
  const sent: ProviderRequest[] = [];
  const provider = {
    id: "codex",
    models: () => [],
    async *stream(request: ProviderRequest) {
      sent.push(request);
      yield {
        type: "message_done" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn" as const,
        message: {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "answer" }],
          meta: { sources: [], webSearch: { calls: 1 } },
        },
      };
    },
  } as unknown as Provider;
  await webSearchTool(() => provider).execute(
    { query: "q" },
    new AbortController().signal,
  );
  expect(sent[0]).toMatchObject({
    model: "gpt-6-luna",
    reasoning: { effort: "medium" },
  });
  // Claude converter default effort comes from the catalog defaultEffort.
  expect(
    toClaudeRequest({
      model: "claude-opus-5-5",
      system: "",
      tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    }),
  ).toMatchObject({ output_config: { effort: "max" } });
  // Question
  const { instance, codex } = await service([], ["gpt-6-luna"]);
  await instance.command({ action: "chat", provider: "codex", text: "質問" });
  for (let i = 0; i < 200 && !codex.requests.length; i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(codex.requests[0]).toMatchObject({
    model: { model: "gpt-6-luna" },
    effort: "high",
  });
  expect(
    (await instance.command({ action: "list" })).questionModels?.codex,
  ).toEqual({
    id: "gpt-6-luna",
    effort: "high",
  });
});

it("resumes a new-format record with its recorded models after the aliases change", async () => {
  const { instance, home } = await service([], []);
  await instance.close();
  const recorded = {
    provider: "codex" as const,
    model: "gpt-6.1-sol",
    effort: "high" as const,
    selectedAs: "codex:sol",
  };
  const { id, file } = await savedRecord(home, (r) => {
    r.planner = recorded;
    r.plan!.tasks[0]!.reviewer = {
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      reason: "other company",
    };
  });
  const before = await readFile(file, "utf8");
  useCatalog(newAliasGeneration); // "sol" now means gpt-7-sol
  const record = JSON.parse(before) as WorkflowRecord;
  expect(impliedRecordModels(record)).toEqual({ reviewers: {} });
  expect(
    resolvePlannerChoice(recorded, [candidate("codex", "gpt-6.1-sol")]),
  ).toMatchObject({
    provider: "codex",
    model: "gpt-6.1-sol",
    selectedAs: "codex:sol",
  });
  const claude = agent("claude", ["claude-haiku-4-5-20251001"]),
    codex = agent("codex", ["gpt-6.1-sol", "gpt-7-sol"]);
  const restarted = new OfficialWorkflowService({
    home,
    fake: false,
    codexPath: "C:/configured/codex.exe",
    agents: { claude: claude.agent, codex: codex.agent },
  });
  services.push(restarted);
  await restarted.command({ action: "list" });
  expect(await readFile(file, "utf8")).toBe(before);
  const view = await restarted.command({ action: "resume", id });
  expect(view.error).toBeUndefined();
  const done = await finished(restarted, id);
  expect(done.status).toBe("completed");
  expect(done.planner).toEqual(recorded);
  // The recorded reviewer (gpt-6.1-sol), not the alias's new target (gpt-7-sol).
  expect(codex.requests.map((r) => [r.phase, r.model.model, r.effort])).toEqual(
    [["review", "gpt-6.1-sol", "high"]],
  );
});
async function finished(instance: OfficialWorkflowService, id: string) {
  for (let i = 0; i < 1500; i++) {
    const view = await instance.command({ action: "list" });
    const record = view.records.find((r) => r.record.id === id)?.record;
    if (record && !view.activeId && record.status !== "interrupted")
      return record;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("resume did not finish");
}
