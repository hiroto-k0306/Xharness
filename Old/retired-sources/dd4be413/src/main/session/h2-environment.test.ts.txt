import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionController } from "./controller.js";
import {
  FakeProvider,
  type FakeStep,
} from "../providers/fake/fake-provider.js";
import { type ProviderRequest } from "../providers/provider.js";
import { type UiEvent } from "../../shared/ipc.js";

const response: FakeStep = {
  type: "message",
  stopReason: "end_turn",
  message: { role: "assistant", content: [{ type: "text", text: "done" }] },
};
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
it("diagnoses once, fixes the summary despite PATH changes and keeps it after resume", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-env-session-"));
  const requests: ProviderRequest[] = [];
  const events: UiEvent[] = [];
  const make = () =>
    new SessionController({
      home,
      provider: new FakeProvider({
        script: [response, response],
        onRequest: (r) => requests.push(r),
      }),
      model: "claude-opus-5-5",
      fake: true,
      version: "test",
      host: { pickFolder: async () => undefined },
      emit: (e) => events.push(e),
      phase4: true,
    });
  await writeFile(join(home, "config.yaml"), "workflow: {mode: off}\n");
  const controller = make();
  await controller.init();
  const created = await controller.handle({
    type: "new_session",
    workspaceId: null,
  });
  if (!created.ok || !created.sessionId) throw new Error("no session");
  const id = created.sessionId;
  vi.stubEnv("PATH", home);
  vi.stubEnv("LOCALAPPDATA", home);
  vi.stubEnv("ProgramFiles", home);
  let resumed: SessionController | undefined;
  try {
    await controller.handle({ type: "send", sessionId: id, text: "first" });
    await until(() =>
      events.some((e) => e.type === "turn" && e.status === "idle"),
    );
    const warnings = events.filter(
      (e) =>
        e.type === "notice" &&
        e.tone === "warn" &&
        e.message.startsWith("環境診断"),
    );
    expect(warnings).toHaveLength(3);
    const stored = JSON.parse(
      await readFile(join(home, "sessions", "index.json"), "utf8"),
    ).find((s: { id: string }) => s.id === id);
    expect(stored.environment.cli.rg).toBe(false);
    await writeFile(
      join(home, process.platform === "win32" ? "rg.exe" : "rg"),
      "test placeholder",
    );
    if (process.platform !== "win32") await chmod(join(home, "rg"), 0o755);
    await controller.handle({ type: "send", sessionId: id, text: "second" });
    await until(
      () =>
        requests.length === 2 &&
        events.filter((e) => e.type === "turn" && e.status === "idle")
          .length === 2,
    );
    expect(requests[1]!.system).toBe(requests[0]!.system);
    expect(
      events.filter(
        (e) => e.type === "notice" && e.message.startsWith("環境診断"),
      ),
    ).toHaveLength(3);
    await controller.shutdown();
    resumed = make();
    await resumed.init();
    await resumed.handle({ type: "send", sessionId: id, text: "resumed" });
    await until(
      () =>
        requests.length === 3 &&
        events.filter((e) => e.type === "turn" && e.status === "idle")
          .length === 3,
    );
    expect(requests[2]!.system).toContain(stored.environment.summary);
    expect(
      events.filter(
        (e) => e.type === "notice" && e.message.startsWith("環境診断"),
      ),
    ).toHaveLength(3);
  } finally {
    vi.unstubAllEnvs();
    await controller.shutdown();
    await resumed?.shutdown();
  }
});
