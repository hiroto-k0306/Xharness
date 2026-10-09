import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { SessionController } from "./controller.js";
import {
  FakeProvider,
  type FakeStep,
} from "../providers/fake/fake-provider.js";
import { type UiEvent } from "../../shared/ipc.js";
import { type ProviderRequest } from "../providers/provider.js";

it("model apply affects only its session; defaults affect only future sessions", async () => {
  const s = await setup([]);
  const next = await s.c.handle({ type: "new_session", workspaceId: null });
  if (!next.ok || !next.sessionId) throw new Error("create failed");
  expect(
    await s.c.handle({
      type: "set_model",
      sessionId: s.id,
      model: "codex:luna",
      effort: "low",
    }),
  ).toMatchObject({ ok: true });
  expect(
    await s.c.handle({
      type: "set_model",
      sessionId: s.id,
      model: "codex:luna",
      effort: "ultra" as "high",
    }),
  ).toMatchObject({ ok: false });
  expect(
    await s.c.handle({
      type: "set_model",
      sessionId: s.id,
      model: "claude:fable",
    }),
  ).toMatchObject({ ok: false });
  let state = await s.c.state();
  expect(state.sessions.find((x) => x.id === next.sessionId)?.model).toBe(
    "claude-opus-5-5",
  );
  expect(state.sessions.find((x) => x.id === s.id)?.model).toBe("gpt-6-luna");
  expect(
    await s.c.handle({
      type: "set_default_model",
      model: "claude-sonnet-5-5",
      effort: "max",
    }),
  ).toMatchObject({ ok: true });
  const third = await s.c.handle({ type: "new_session", workspaceId: null });
  state = await s.c.state();
  expect(state.sessions.find((x) => x.id === next.sessionId)?.model).toBe(
    "claude-opus-5-5",
  );
  expect(
    state.sessions.find((x) => third.ok && x.id === third.sessionId),
  ).toMatchObject({ model: "claude:sonnet", effort: "max" });
  expect(await readFile(join(s.home, "config.yaml"), "utf8")).toContain(
    "claude:sonnet",
  );
  await s.c.shutdown();
});
async function setup(
  script: FakeStep[],
  project = "",
  codexScript: FakeStep[] = [],
) {
  const home = await mkdtemp(join(tmpdir(), "xh-child-close-"));
  if (project) await writeFile(join(home, "config.yaml"), project);
  const requests: ProviderRequest[] = [];
  const events: UiEvent[] = [];
  const provider = new FakeProvider({
    script,
    onRequest: (r) => requests.push(r),
  });
  const c = new SessionController({
    home,
    provider,
    providers: [
      provider,
      new FakeProvider({
        provider: "codex",
        script: codexScript,
        onRequest: (r) => requests.push(r),
      }),
    ],
    model: "claude-opus-5-5",
    phase4: true,
    fake: true,
    version: "test",
    host: { pickFolder: async () => undefined },
    emit: (event) => events.push(event),
  });
  await c.init();
  const created = await c.handle({ type: "new_session", workspaceId: null });
  if (!created.ok || !created.sessionId) throw new Error("create failed");
  return { c, home, requests, events, id: created.sessionId };
}
