import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { SessionController } from "./controller.js";
import { SessionStore } from "./store.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import {
  loadCatalog,
  overrideCatalogForTest,
  resolveModelPolicy,
} from "../config/catalog.js";
import type { OfficialSessionSubmission } from "../../shared/official-session.js";

const shipped = structuredClone(loadCatalog());
const fixtures: { home: string; controller: SessionController }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.controller.shutdown();
    await rm(f.home, { recursive: true, force: true });
  }
  overrideCatalogForTest(undefined);
});
function catalog(id: string, enabled = true) {
  const next = structuredClone(shipped);
  const model = next.models.find((m) => m.alias === "opus")!;
  model.historicalIds = [...(model.historicalIds ?? []), model.id];
  model.id = id;
  model.enabled = enabled;
  overrideCatalogForTest(next);
}
async function setup(model = "claude:opus") {
  const home = await mkdtemp(join(tmpdir(), "xh-alias-policy-"));
  const legacy = new FakeProvider();
  const oldStream = vi.spyOn(legacy, "stream");
  // This seam records concrete dispatch choices without an SDK or network.
  const dispatch = vi.fn(async (id: string) => id);
  const official = vi.fn(async (r: OfficialSessionSubmission) => {
    const policy = resolveModelPolicy(r.model, r.effort);
    await dispatch(policy.id);
    return {
      summary: `answer from ${policy.id}`,
      workflowId: "offline",
      status: "completed",
    };
  });
  const controller = new SessionController({
    home,
    model,
    effort: "high",
    fake: true,
    version: "test",
    provider: legacy,
    officialSession: official,
    host: { pickFolder: async () => undefined },
    emit: () => {},
  });
  fixtures.push({ home, controller });
  await controller.init();
  const made = await controller.handle({
    type: "new_session",
    workspaceId: null,
  });
  if (!made.ok || !made.sessionId) throw new Error(JSON.stringify(made));
  const id = made.sessionId;
  const idle = () =>
    vi.waitFor(async () =>
      expect(
        (await controller.state()).sessions.find((s) => s.id === id)?.status,
      ).toBe("idle"),
    );
  const send = async (text: string) => {
    expect(
      (await controller.handle({ type: "send", sessionId: id, text })).ok,
    ).toBe(true);
    await idle();
  };
  return { home, controller, id, official, dispatch, oldStream, idle, send };
}

it("stores aliases for new, explicit selection and defaults while preserving earlier session policy", async () => {
  const original = shipped.models.find((m) => m.alias === "opus")!.id;
  const f = await setup(original);
  expect(
    (await f.controller.state()).sessions.find((s) => s.id === f.id)?.model,
  ).toBe("claude:opus");
  expect(
    await f.controller.handle({
      type: "set_model",
      sessionId: f.id,
      model: "claude:sonnet",
      effort: "medium",
    }),
  ).toMatchObject({ ok: true });
  expect(
    await f.controller.handle({
      type: "set_default_model",
      model: "codex:sol",
      effort: "high",
    }),
  ).toMatchObject({ ok: true });
  expect(await readFile(join(f.home, "config.yaml"), "utf8")).toContain(
    "model: codex:sol",
  );
  const second = await f.controller.handle({
    type: "new_session",
    workspaceId: null,
  });
  if (!second.ok || !second.sessionId) throw new Error(JSON.stringify(second));
  const store = new SessionStore(f.home);
  await store.load();
  expect(store.get(f.id)?.model).toBe("claude:sonnet");
  expect(store.get(second.sessionId!)?.model).toBe("codex:sol");
  expect(f.oldStream).not.toHaveBeenCalled();
});

it("resolves a new catalog generation on each send without rewriting policy or previous history", async () => {
  catalog("claude-opus-generation-one");
  const f = await setup();
  await f.send("first");
  const path = join(f.home, "sessions", `${f.id}.jsonl`);
  const first = await readFile(path, "utf8");
  catalog("claude-opus-generation-two");
  await f.send("second");
  expect(f.official.mock.calls.map(([r]) => r.model)).toEqual([
    "claude:opus",
    "claude:opus",
  ]);
  expect(f.dispatch.mock.calls.map(([id]) => id)).toEqual([
    "claude-opus-generation-one",
    "claude-opus-generation-two",
  ]);
  expect((await readFile(path, "utf8")).startsWith(first)).toBe(true);
  const store = new SessionStore(f.home);
  await store.load();
  expect(store.get(f.id)?.model).toBe("claude:opus");
  catalog("claude-opus-generation-two", false);
  await f.send("must stop");
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  expect(f.oldStream).not.toHaveBeenCalled();
});

it("a model selection during a call affects the next call and does not mutate the active request", async () => {
  const f = await setup();
  let release!: () => void;
  f.official.mockImplementationOnce(async (request) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      summary: `unchanged ${request.model}`,
      workflowId: "held",
      status: "completed",
    };
  });
  await f.controller.handle({ type: "send", sessionId: f.id, text: "first" });
  await vi.waitFor(() => expect(f.official).toHaveBeenCalledOnce());
  expect(
    await f.controller.handle({
      type: "set_model",
      sessionId: f.id,
      model: "codex:luna",
      effort: "low",
    }),
  ).toMatchObject({ ok: true });
  expect(f.official.mock.calls[0]![0]).toMatchObject({
    model: "claude:opus",
    effort: "high",
  });
  release();
  await f.idle();
  await f.send("next");
  expect(f.official.mock.calls[1]![0]).toMatchObject({
    model: "codex:luna",
    effort: "low",
  });
  expect(f.oldStream).not.toHaveBeenCalled();
});

it("rejects unknown or unsupported selections without changing the saved policy or dispatching", async () => {
  const f = await setup();
  const next = structuredClone(shipped);
  next.models.find((m) => m.alias === "opus")!.efforts = { high: "high" };
  overrideCatalogForTest(next);
  for (const choice of [
    { model: "claude:unknown", effort: "high" },
    { model: "claude:opus", effort: "low" },
  ] as const)
    expect(
      await f.controller.handle({
        type: "set_model",
        sessionId: f.id,
        ...choice,
      }),
    ).toMatchObject({ ok: false });
  expect(
    (await f.controller.state()).sessions.find((s) => s.id === f.id)?.model,
  ).toBe("claude:opus");
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.oldStream).not.toHaveBeenCalled();
});
