import { expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "../session/improvements.fixture.js";
import { SessionStore, WorkspaceStore } from "../session/store.js";
import { FakeLocalBrowser } from "./fake-browser.js";
import { LocalBrowserSessions } from "./session.js";
import { type LocalBrowserAction } from "../../shared/local-browser.js";

async function setup() {
  const f = await fixture(),
    sessions = new SessionStore(f.home),
    workspaces = new WorkspaceStore(f.home);
  await sessions.load();
  await workspaces.load();
  const source = sessions.get(f.sessionId)!;
  let now = Date.now();
  const browsers: FakeLocalBrowser[] = [];
  const service = new LocalBrowserSessions(
    () => {
      const b = new FakeLocalBrowser();
      browsers.push(b);
      return b;
    },
    () => now,
  );
  const scope = {
    home: f.home,
    sessions,
    workspaces,
    sessionId: f.sessionId,
    workspaceId: source.workspaceId,
    cwd: source.cwd,
    clean: (s: string) => s,
  };
  const run = (action: LocalBrowserAction, s = service) =>
    s.run(
      scope,
      action,
      async () => {},
      async () => {},
    );
  const prepare = async () => {
    const o = (await run({ action: "observe" })).observation!;
    return (await run({ action: "prepare", observationId: o.id }))
      .confirmation!;
  };
  return {
    ...f,
    scope,
    service,
    browsers,
    run,
    prepare,
    advance: () => {
      now += 60_001;
    },
    journal: join(f.home, "local-browser", `${f.sessionId}.json`),
  };
}
it("expires confirmations, rejects tab replacement, and cancels before execution", async () => {
  const f = await setup(),
    p = await f.prepare();
  f.advance();
  await expect(
    f.run({ action: "confirm", confirmationId: p.id, confirmed: true }),
  ).rejects.toThrow("失効");
  const p2 = await f.prepare(),
    b = f.browsers.at(-1)!;
  const original = b.observe.bind(b);
  vi.spyOn(b, "observe").mockImplementation(async (signal) => ({
    ...(await original(signal)),
    tabId: "different-tab",
  }));
  await expect(
    f.run({ action: "confirm", confirmationId: p2.id, confirmed: true }),
  ).rejects.toThrow("変更");
  const p3 = await f.prepare();
  await f.service.stop(f.sessionId);
  await expect(
    f.run({ action: "confirm", confirmationId: p3.id, confirmed: true }),
  ).rejects.toThrow("古い観測");
  expect(f.browsers.every((b) => b.clicks === 0)).toBe(true);
});
it("recovers a pending journal only as unknown and never reconstructs or executes its operation", async () => {
  const f = await setup(),
    p = await f.prepare();
  await f.run({ action: "confirm", confirmationId: p.id, confirmed: true });
  const data = JSON.parse(await readFile(f.journal, "utf8"));
  data.operations[0].status = "pending";
  delete data.operations[0].finishedAt;
  delete data.operations[0].countAfter;
  await writeFile(f.journal, JSON.stringify(data));
  const factory = vi.fn(() => new FakeLocalBrowser()),
    restarted = new LocalBrowserSessions(factory);
  expect(await f.run({ action: "view" }, restarted)).toMatchObject({
    phase: "unknown",
    operations: [{ status: "unknown", id: p.id }],
  });
  await expect(f.run({ action: "observe" }, restarted)).rejects.toThrow(
    "未確定",
  );
  await expect(
    f.run(
      { action: "confirm", confirmationId: p.id, confirmed: true },
      restarted,
    ),
  ).rejects.toThrow("未確定");
  expect(factory).not.toHaveBeenCalled();
  expect(f.browsers[0]!.clicks).toBe(1);
});
it("keeps corrupt journals intact and fails closed; changed project metadata cannot authorize an observation", async () => {
  const f = await setup();
  await f.prepare();
  await writeFile(f.journal, "{torn");
  for (let i = 0; i < 2; i++)
    await expect(f.run({ action: "observe" })).rejects.toThrow(
      "操作記録が不明",
    );
  expect(await readFile(f.journal, "utf8")).toBe("{torn");
  await f.scope.sessions.save({
    ...f.scope.sessions.get(f.sessionId)!,
    workspaceId: null,
  });
  await expect(f.run({ action: "observe" })).rejects.toThrow("境界");
  expect(f.browsers.every((b) => b.clicks === 0)).toBe(true);
});
