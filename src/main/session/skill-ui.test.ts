import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { SessionController } from "./controller.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { type UiEvent } from "../../shared/ipc.js";
import { parseCommand } from "../../shared/ipc.js";
import { readTraceReplay } from "./report-trace.js";
import {
  evaluateTrace,
  evaluateUiSkillReads,
  renderEvaluation,
} from "./evaluation.js";
import { skillLoadPrompt } from "../../shared/project-skills.js";
const fixtures: { c: SessionController; base: string }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.c.shutdown();
    await rm(f.base, { recursive: true, force: true });
  }
});
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "xh-skill-ui-")),
    home = join(base, "home"),
    root = join(base, "root");
  await mkdir(home);
  await mkdir(join(root, ".agents/skills/example"), { recursive: true });
  await writeFile(join(home, "config.yaml"), "workflow: {mode: off}\n");
  const path = join(root, ".agents/skills/example/SKILL.md");
  await writeFile(
    path,
    "---\nname: example\ndescription: Offline recipe\n---\nUI ONLY BODY\n",
  );
  const events: UiEvent[] = [];
  let requests = 0;
  const c = new SessionController({
    home,
    fake: true,
    model: "fake",
    version: "test",
    phase4: true,
    host: { pickFolder: async () => root },
    emit: (e) => events.push(e),
    provider: new FakeProvider({ onRequest: () => requests++ }),
  });
  fixtures.push({ c, base });
  await c.init();
  const picked = await c.handle({ type: "pick_folder" });
  if (!picked.ok || !picked.workspaceId) throw new Error("Workspace missing");
  const created = await c.handle({
    type: "new_session",
    workspaceId: picked.workspaceId,
    readOnly: true,
  });
  if (!created.ok || !created.sessionId) throw new Error("Session missing");
  const id = created.sessionId;
  const respond = async (decision: "allow" | "deny" = "allow") => {
    await vi.waitFor(() =>
      expect(
        events.filter((e) => e.type === "permission_request").length,
      ).toBeGreaterThan(0),
    );
    const e = events
      .filter((e) => e.type === "permission_request")
      .at(-1) as Extract<UiEvent, { type: "permission_request" }>;
    events.splice(0);
    await c.handle({
      type: "permission_response",
      sessionId: id,
      requestId: e.requestId,
      decision,
    });
  };
  const list = async () => {
    const job = c.handle({
      type: "project_skills",
      sessionId: id,
      request: { action: "list", requestId: "list" },
    });
    await respond();
    const r = await job;
    if (!r.ok || r.skills?.operation !== "list")
      throw new Error("Listing missing");
    return r.skills;
  };
  return {
    base,
    home,
    root,
    path,
    c,
    events,
    id,
    respond,
    list,
    requests: () => requests,
  };
}
it("UI list/preview use the gate and real budgets but never send body or model calls; trace shows preview separately", async () => {
  const f = await fixture();
  const e = (await f.list()).entries[0]!;
  const job = f.c.handle({
    type: "project_skills",
    sessionId: f.id,
    request: {
      action: "preview",
      requestId: "preview",
      source: e.source,
      hash: e.hash,
    },
  });
  await f.respond();
  const r = await job;
  expect(r.ok && r.skills?.operation === "load" && r.skills.body).toContain(
    "UI ONLY BODY",
  );
  expect(f.requests()).toBe(0);
  const trace = await readTraceReplay(f.home, f.id, (s) => s);
  expect(evaluateTrace(trace)).toHaveLength(0);
  expect(evaluateUiSkillReads(trace)).toHaveLength(2);
  expect(renderEvaluation(trace)).toContain("UIのスキル確認");
  await f.c.handle({
    type: "send",
    sessionId: f.id,
    text: skillLoadPrompt(e.source, e.hash),
  });
  await f.respond();
  await vi.waitFor(async () =>
    expect(
      (await f.c.state()).sessions.find((s) => s.id === f.id)?.status,
    ).toBe("idle"),
  );
  expect(f.requests()).toBe(2);
});
it("duplicate requests are fenced and denial/cancellation release the runtime, including early cancellation", async () => {
  const f = await fixture();
  const request = { action: "list" as const, requestId: "one" };
  const job = f.c.handle({ type: "project_skills", sessionId: f.id, request });
  expect(
    await f.c.handle({
      type: "project_skills",
      sessionId: f.id,
      request: { ...request, requestId: "two" },
    }),
  ).toMatchObject({ ok: false });
  await f.respond("deny");
  expect(await job).toMatchObject({
    ok: false,
    error: expect.stringContaining("拒否"),
  });
  const cancelled = f.c.handle({
    type: "project_skills",
    sessionId: f.id,
    request,
  });
  expect(
    await f.c.handle({
      type: "project_skills",
      sessionId: f.id,
      request: { action: "cancel", requestId: "one" },
    }),
  ).toMatchObject({ ok: true });
  expect(await cancelled).toMatchObject({
    ok: false,
    error: expect.stringContaining("取消"),
  });
  expect((await f.list()).entries).toHaveLength(1);
});
it("renderer reconnect cancels orphaned local reads but replays active task permissions without approval", async () => {
  const f = await fixture();
  const job = f.c.handle({
    type: "project_skills",
    sessionId: f.id,
    request: { action: "list", requestId: "orphan" },
  });
  await vi.waitFor(() =>
    expect(f.events.some((e) => e.type === "permission_request")).toBe(true),
  );
  f.events.length = 0;
  expect(await f.c.handle({ type: "ready" })).toMatchObject({ ok: true });
  expect(await job).toMatchObject({ ok: false });
  expect(f.events.some((e) => e.type === "permission_request")).toBe(false);
  expect(f.requests()).toBe(0);
  expect((await f.c.state()).sessions.find((s) => s.id === f.id)?.status).toBe(
    "idle",
  );
  const e = (await f.list()).entries[0]!;
  await f.c.handle({
    type: "send",
    sessionId: f.id,
    text: skillLoadPrompt(e.source, e.hash),
  });
  await vi.waitFor(() =>
    expect(f.events.some((e) => e.type === "permission_request")).toBe(true),
  );
  const pending = f.events.find((e) => e.type === "permission_request")!;
  const calls = f.requests();
  f.events.length = 0;
  await f.c.handle({ type: "ready" });
  expect(f.events.find((e) => e.type === "permission_request")).toEqual(
    pending,
  );
  expect(f.events.find((e) => e.type === "transcript")).toMatchObject({
    sessionId: f.id,
  });
  expect(f.events.find((e) => e.type === "turn")).toMatchObject({
    status: "running",
  });
  expect(f.requests()).toBe(calls);
  await f.respond("deny");
  await vi.waitFor(async () =>
    expect(
      (await f.c.state()).sessions.find((s) => s.id === f.id)?.status,
    ).toBe("idle"),
  );
  const trace = await readTraceReplay(f.home, f.id, (s) => s);
  expect(evaluateUiSkillReads(trace)).toHaveLength(2);
  expect(evaluateTrace(trace)).toHaveLength(1);
});
it("a changed or deleted preview fails and a new listing is needed; IPC cannot load or escape paths", async () => {
  const f = await fixture(),
    e = (await f.list()).entries[0]!;
  await writeFile(
    f.path,
    "---\nname: example\ndescription: changed\n---\nNEW BODY\n",
  );
  const job = f.c.handle({
    type: "project_skills",
    sessionId: f.id,
    request: {
      action: "preview",
      requestId: "stale",
      source: e.source,
      hash: e.hash,
    },
  });
  await f.respond();
  expect(await job).toMatchObject({ ok: false });
  expect((await f.list()).entries[0]!.hash).not.toBe(e.hash);
  await rm(f.path);
  expect((await f.list()).entries).toHaveLength(0);
  for (const request of [
    { action: "load", requestId: "x" },
    { action: "preview", requestId: "x", source: "../SKILL.md", hash: e.hash },
  ])
    expect(
      parseCommand({ type: "project_skills", sessionId: f.id, request }),
    ).toBeUndefined();
});
it("reference UI inspection/preview remain local and actual reference load has separate versioned trace evidence", async () => {
  const f = await fixture();
  await writeFile(
    f.path,
    "---\nname: example\ndescription: Reference fixture\n---\n[手順](<references/日本語.md>)\n",
  );
  const referenceSource = ".agents/skills/example/references/日本語.md";
  await mkdir(join(f.root, ".agents/skills/example/references"));
  await writeFile(join(f.root, referenceSource), "LOCAL DOCUMENT BODY");
  const e = (await f.list()).entries[0]!;
  const inspectJob = f.c.handle({
    type: "project_skills",
    sessionId: f.id,
    request: {
      action: "reference_inspect",
      requestId: "ref-inspect",
      source: e.source,
      hash: e.hash,
      referenceSource,
    },
  });
  await f.respond();
  const inspect = await inspectJob;
  if (!inspect.ok || inspect.skills?.operation !== "reference_inspect")
    throw new Error("Reference missing");
  expect("body" in inspect.skills).toBe(false);
  const referenceHash = inspect.skills.reference.hash;
  const previewRequest = {
    action: "reference_preview" as const,
    requestId: "ref-preview",
    source: e.source,
    hash: e.hash,
    referenceSource,
    referenceHash,
  };
  const denied = f.c.handle({
    type: "project_skills",
    sessionId: f.id,
    request: previewRequest,
  });
  await f.respond("deny");
  expect(await denied).toMatchObject({ ok: false });
  const previewJob = f.c.handle({
    type: "project_skills",
    sessionId: f.id,
    request: previewRequest,
  });
  await f.respond();
  const preview = await previewJob;
  expect(
    preview.ok && preview.skills?.operation === "load" && preview.skills.body,
  ).toBe("LOCAL DOCUMENT BODY");
  expect(f.requests()).toBe(0);
  const trace = await readTraceReplay(f.home, f.id, (s) => s);
  expect(evaluateTrace(trace)).toHaveLength(0);
  const uiReads = evaluateUiSkillReads(trace);
  expect(uiReads).toHaveLength(4);
  expect(JSON.stringify(uiReads)).toContain(referenceSource);
  expect(JSON.stringify(uiReads)).not.toContain("LOCAL DOCUMENT BODY");
  await f.c.handle({
    type: "send",
    sessionId: f.id,
    text: skillLoadPrompt(e.source, e.hash, inspect.skills.reference),
  });
  await f.respond();
  await vi.waitFor(async () =>
    expect(
      (await f.c.state()).sessions.find((s) => s.id === f.id)?.status,
    ).toBe("idle"),
  );
  expect(f.requests()).toBe(2);
  const tasks = evaluateTrace(await readTraceReplay(f.home, f.id, (s) => s));
  expect(JSON.stringify(tasks[0]?.skillReads)).toContain(referenceSource);
  expect(JSON.stringify(tasks[0]?.skillReads)).not.toContain(
    "LOCAL DOCUMENT BODY",
  );
  expect(
    parseCommand({
      type: "project_skills",
      sessionId: f.id,
      request: {
        ...previewRequest,
        referenceSource: ".agents/skills/other/doc.md",
      },
    }),
  ).toBeUndefined();
});
