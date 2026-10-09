import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionController } from "./controller.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { loadMainConfig } from "../config/config.js";

it("rejects retired authentication actions without changing saved settings", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-controller-auth-retired-"));
  const config = "auth:\n  autoRefresh: true\n  claudeCliPath: custom-claude\n";
  await writeFile(join(home, "config.yaml"), config);
  const controller = new SessionController({
    home,
    fake: true,
    version: "test",
    provider: new FakeProvider(),
    model: "claude:opus",
    host: { pickFolder: async () => undefined },
    emit: () => {},
  });
  await controller.init();
  try {
    for (const command of [
      { type: "refresh_auth" } as const,
      { type: "authenticate", provider: "claude" } as const,
      { type: "authenticate", provider: "codex" } as const,
    ]) {
      expect(await controller.handle(command)).toMatchObject({
        ok: false,
        error: expect.stringContaining("公式CLI"),
      });
    }
    expect((await controller.state()).authentication).toBeUndefined();
    expect(await readFile(join(home, "config.yaml"), "utf8")).toBe(config);
    expect((await loadMainConfig(home)).auth).toMatchObject({
      autoRefresh: true,
      claudeCliPath: "custom-claude",
    });
  } finally {
    await controller.shutdown();
  }
});
