import { expect, it, vi } from "vitest";
import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { handoffCli } from "../../../scripts/handoff.js";
import { fixture } from "./handoffs.fixture.js";
vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));

it("headless requires same-process preview confirmation; cancel/list/send never call a provider", async () => {
  const f = await fixture();
  const dest = await f.c.handle({
    type: "new_session",
    workspaceId: f.workspaceId,
  });
  if (!dest.ok || !dest.sessionId) throw new Error("destination");
  await f.c.handle({ type: "send", sessionId: f.sessionId, text: "ping" });
  await vi.waitFor(async () =>
    expect(
      (await f.c.state()).sessions.find((s) => s.id === f.sessionId)?.status,
    ).toBe("idle"),
  );
  await f.c.shutdown();
  const calls = f.requests.mock.calls.length,
    logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const args = [
    "--home",
    f.home,
    "--session",
    f.sessionId,
    "--destination",
    dest.sessionId,
  ];
  const question = vi.fn().mockResolvedValue("no"),
    close = vi.fn();
  vi.mocked(createInterface).mockReturnValue({
    question,
    close,
  } as unknown as ReturnType<typeof createInterface>);
  await handoffCli(args);
  await expect(readFile(join(f.home, "handoffs.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  question.mockImplementation(
    async (prompt: string) => prompt.match(/SEND ([\w-]+)/)![0],
  );
  await handoffCli(args);
  const records = JSON.parse(
    await readFile(join(f.home, "handoffs.json"), "utf8"),
  );
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    sourceId: f.sessionId,
    destinationId: dest.sessionId,
    body: "pong",
  });
  await handoffCli(["--home", f.home, "--session", dest.sessionId, "--list"]);
  expect(
    logs.mock.calls.some(
      ([text]) => typeof text === "string" && text.includes('"receivedAt"'),
    ),
  ).toBe(true);
  expect(close).toHaveBeenCalledTimes(2);
  expect(f.requests).toHaveBeenCalledTimes(calls);
}, 20000);
