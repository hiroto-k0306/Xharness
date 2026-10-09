import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  OfficialSkillBundle,
  OfficialSkillSelection,
} from "../../../shared/official-skills.js";
import { OfficialSkills } from "../../session/official-skills.js";
import { runNativeTask } from "./native-runtime.js";
import { fixtureWorkflowOptions, fixtureAgents } from "./fixtures.js";
import { OfficialWorkflowService } from "./service.js";
import type { WorkflowRecord } from "./runtime.js";
import {
  parseSkillSelections,
  resolveCallSkills,
  skillEvidence,
  skillSelections,
  validateSavedSkillSelections,
} from "./skill-selection.js";
import { communicationInput } from "./communication.js";
import { diagnostics } from "./diagnostics.js";
const homes: string[] = [];
const services: OfficialWorkflowService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const cwd of homes.splice(0))
    await rm(cwd, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const body =
  "---\nname: demo-skill\ndescription: A bounded fixture skill\n---\nPRIVATE_SKILL_BODY_FIXTURE\n";
const bundle = (
  provider: "claude" | "codex" = "claude",
): OfficialSkillBundle => ({
  provider,
  scope: "project",
  name: provider === "claude" ? "demo-skill" : "codex-demo",
  source: `/tmp/.${provider === "claude" ? "claude" : "agents"}/skills/demo-skill/SKILL.md`,
  hash: hash(body),
  bundleHash: "b".repeat(64),
  files: [{ relativePath: "SKILL.md", body, hash: hash(body) }],
});
const record = (selections: OfficialSkillSelection[]): WorkflowRecord => ({
  officialSkills: skillSelections(selections),
  version: 1,
  simulated: true,
  id: "fixture",
  goal: "work",
  cwd: "/tmp",
  startedAt: "2026-10-09",
  status: "planning",
  next: "plan",
  base: "0".repeat(40),
  head: "0".repeat(40),
  correctionRounds: 0,
  calls: [],
  tools: [],
  checks: [],
  reviews: [],
  commits: [],
});
const home = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xh-skill-service-"));
  homes.push(cwd);
  return cwd;
};
async function selectedSkill(cwd: string) {
  const path = join(cwd, ".claude", "skills", "demo-skill");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), body);
  const preview = await new OfficialSkills({ cwd, provider: "claude" }).preview(
    join(path, "SKILL.md"),
  );
  expect(preview.entry.eligible).toBe(true);
  return skillSelections([preview.entry])[0]!;
}
it("validates all pinned versions, then filters only the current provider without changing saved metadata", async () => {
  const all = [bundle(), bundle("codex")];
  const r = record(all);
  const saved = structuredClone(r);
  const resolve = vi.fn(async () => all);
  expect(
    await resolveCallSkills(
      { nativeWork: true, resolveOfficialSkills: resolve },
      r,
      "claude",
      "plan",
      signal(),
    ),
  ).toEqual([all[0]]);
  expect(resolve).toHaveBeenCalledWith(
    skillSelections(all),
    expect.any(AbortSignal),
  );
  expect(r).toEqual(saved);
});
it.each(["question", "fixed", "missing", "stale", "mismatch"] as const)(
  "stops %s before skill dispatch without fallback",
  async (kind) => {
    const r = record([bundle()]);
    const resolver = vi.fn(async () => {
      if (kind === "stale")
        throw new Error("選択したスキルの本文・関連資料の版が変わりました。");
      return kind === "mismatch"
        ? [{ ...bundle(), hash: "c".repeat(64) }]
        : [bundle()];
    });
    const options = {
      nativeWork: kind !== "fixed",
      resolveOfficialSkills: kind === "missing" ? undefined : resolver,
    };
    await expect(
      resolveCallSkills(
        options,
        r,
        "claude",
        kind === "question" ? "conversation" : "implement",
        signal(),
      ),
    ).rejects.toThrow(
      kind === "stale"
        ? "版が変わりました"
        : kind === "mismatch"
          ? "official-skills-selection-mismatch"
          : `official-skills-${kind === "question" ? "question-unsupported" : kind === "fixed" ? "fixed-task-unsupported" : "validation-unavailable"}`,
    );
    expect(r.calls).toEqual([]);
    if (["question", "fixed", "missing"].includes(kind))
      expect(resolver).not.toHaveBeenCalled();
  },
);
it("keeps requested evidence separate from observed/dispatch facts and never stores bundle bodies", () => {
  const selected = bundle();
  const requested = skillSelections([selected]);
  const unconfirmed = skillEvidence(requested);
  expect(unconfirmed).toEqual({ requested });
  const actual = skillEvidence(requested, {
    requested: [{ ...requested[0]!, name: "wrong" }],
    dispatched: [
      { name: selected.name, mechanism: "claude-plugin" },
      { name: "wrong", mechanism: "claude-plugin" },
    ],
    observed: [{ name: selected.name, status: "denied" }],
  });
  expect(actual).toEqual({
    requested,
    dispatched: [{ name: selected.name, mechanism: "claude-plugin" }],
    observed: [{ name: selected.name, status: "denied" }],
  });
  expect(JSON.stringify(actual)).not.toContain("PRIVATE_SKILL_BODY");
  expect(
    communicationInput({ officialSkills: [selected] }).input.text,
  ).not.toContain("PRIVATE_SKILL_BODY");
  const fake = fixtureWorkflowOptions("/tmp");
  const request = {
    ...fake,
    requestId: "x",
    taskId: "x",
    phase: "plan" as const,
    model: fake.models[0]!,
    prompt: "test",
    effort: null,
    outputSchema: {},
    timeoutMs: 1000,
    tool: async () => {},
    approve: async () => false,
    officialSkills: [selected],
  };
  expect(
    JSON.stringify(diagnostics(request, "read-only", "never").data),
  ).not.toContain("PRIVATE_SKILL_BODY");
});
it("rejects renderer bodies/permissions, duplicate skill names and malformed persisted evidence", () => {
  const selected = skillSelections([bundle()])[0]!;
  expect(() =>
    parseSkillSelections([{ ...selected, body: "untrusted" }]),
  ).toThrow();
  expect(() => parseSkillSelections([selected, selected])).toThrow(
    "duplicate-name",
  );
  const r = record([selected]);
  r.calls.push({
    requestId: "x",
    phase: "plan",
    provider: "claude",
    requestedModel: "fixture-opus",
    effort: "high",
    status: "running",
    officialSkills: {
      requested: [selected],
      observed: [{ name: selected.name, status: "completed" }],
    },
  });
  expect(() => validateSavedSkillSelections(r)).not.toThrow();
  r.calls[0]!.officialSkills = {
    requested: [{ ...selected, body: "untrusted" } as never],
  };
  expect(() => validateSavedSkillSelections(r)).toThrow();
});
it("revalidates every native phase, gives only selected provider bundles and persists metadata/evidence", async () => {
  const cwd = await home();
  await writeFile(join(cwd, "add.mjs"), "export const add=(a,b)=>a-b;\n");
  const selected = bundle();
  const fake = fixtureAgents("claude", false);
  const run = fake.agents.claude.run;
  fake.agents.claude.run = async (request, s) => {
    const result = await run(request, s);
    return {
      ...result,
      officialSkillsEvidence: {
        requested: skillSelections(request.officialSkills ?? []),
        dispatched: request.officialSkills?.map((skill) => ({
          name: skill.name,
          mechanism: "claude-plugin" as const,
        })),
      },
    };
  };
  const reread = vi.fn(async () => [selected]);
  const options = fixtureWorkflowOptions(cwd, {
    agents: fake.agents,
    officialSkills: skillSelections([selected]),
    resolveOfficialSkills: reread,
    save: async () => {},
  });
  const result = await runNativeTask(options, signal());
  expect(result.status).toBe("completed");
  expect(reread).toHaveBeenCalledTimes(3);
  expect(
    fake.requests
      .filter((r) => r.model.provider === "claude")
      .every((r) => r.officialSkills?.[0]?.files[0]?.body === body),
  ).toBe(true);
  expect(
    fake.requests
      .filter((r) => r.model.provider === "codex")
      .every((r) => !r.officialSkills),
  ).toBe(true);
  expect(
    result.calls
      .filter((c) => c.provider === "claude")
      .every(
        (c) => c.officialSkills?.dispatched?.[0]?.mechanism === "claude-plugin",
      ),
  ).toBe(true);
  expect(
    result.calls.find((c) => c.provider === "codex")?.officialSkills,
  ).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SKILL_BODY");
});
it("stops stale skills after approval before implementation and preserves planning evidence", async () => {
  const cwd = await home();
  await writeFile(join(cwd, "add.mjs"), "export const add=(a,b)=>a-b;\n");
  const selected = bundle();
  const fake = fixtureAgents("claude", false);
  let changed = false;
  const options = fixtureWorkflowOptions(cwd, {
    agents: fake.agents,
    officialSkills: skillSelections([selected]),
    resolveOfficialSkills: async () => {
      if (changed)
        throw new Error("選択したスキルの本文・関連資料の版が変わりました。");
      return [selected];
    },
    approve: async () => {
      changed = true;
      return true;
    },
    save: async () => {},
  });
  const result = await runNativeTask(options, signal());
  expect(result.status).toBe("failed");
  expect(result.error).toContain("版が変わりました");
  expect(fake.requests.map((r) => r.phase)).toEqual(["plan"]);
  expect(result.calls).toHaveLength(1);
  expect(result.plan).toBeDefined();
});
it("ordinary questions explicitly reject selected skills after classification without injecting a reference", async () => {
  const cwd = await home();
  const selected = await selectedSkill(cwd);
  const service = new OfficialWorkflowService({
    home: await home(),
    fake: true,
  });
  services.push(service);
  const result = await service.submitSession(
    {
      sessionId: "skill-question",
      cwd,
      model: "claude:opus",
      effort: "high",
      text: "ordinary question",
      history: [],
      officialSkills: [selected],
      automaticWork: true,
    },
    signal(),
  );
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("通常のnative作業だけ");
  const r = service.view().records[0]!.record;
  expect(r.error).toBe("official-skills-question-unsupported");
  expect(r.calls.map((c) => c.phase)).toEqual(["conversation"]);
  expect(r.calls[0]!.officialSkills).toBeUndefined();
  expect(r.calls[0]!.communication?.input.text).not.toContain(
    "PRIVATE_SKILL_BODY",
  );
});
it("rejects stale selection before classification/communication", async () => {
  const cwd = await home();
  const selected = await selectedSkill(cwd);
  await writeFile(selected.source, body + "changed");
  const service = new OfficialWorkflowService({
    home: await home(),
    fake: true,
  });
  services.push(service);
  await expect(
    service.submitSession(
      {
        sessionId: "skill-stale",
        cwd,
        model: "claude:opus",
        effort: "high",
        text: "work",
        history: [],
        officialSkills: [selected],
        automaticWork: true,
      },
      signal(),
    ),
  ).rejects.toThrow("版が変わりました");
  expect(service.view().records).toEqual([]);
});

it("preserves unsupported Codex requested selections and starts no classifier/planner", async () => {
  const cwd = await home();
  const skillDir = join(cwd, ".agents", "skills", "codex-demo");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    body.replace("demo-skill", "codex-demo"),
  );
  const preview = await new OfficialSkills({ cwd, provider: "codex" }).preview(
    join(skillDir, "SKILL.md"),
  );
  expect(preview.entry.eligible).toBe(true);
  const service = new OfficialWorkflowService({
    home: await home(),
    fake: true,
  });
  services.push(service);
  const result = await service.submitSession(
    {
      sessionId: "codex-skill",
      cwd,
      model: "codex:sol",
      effort: "low",
      text: "auto-work: fix addition",
      history: [],
      officialSkills: skillSelections([preview.entry]),
      automaticWork: true,
    },
    signal(),
  );
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("隔離境界を確認できない");
  const saved = service.view().records[0]!.record;
  expect(saved.calls).toEqual([]);
  expect(saved.officialSkills).toEqual(skillSelections([preview.entry]));
  expect(saved.error).toBe("official-skills-codex-isolation-unverified");
});

it("does not dispatch when cancelled during bundle validation", async () => {
  const selected = bundle();
  const r = record([selected]);
  const controller = new AbortController();
  await expect(
    resolveCallSkills(
      {
        nativeWork: true,
        resolveOfficialSkills: async () => {
          controller.abort();
          return [selected];
        },
      },
      r,
      "claude",
      "implement",
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(r.calls).toEqual([]);
});
