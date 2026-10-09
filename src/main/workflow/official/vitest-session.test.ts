import { expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfficialWorkflowService } from "./service.js";

it("normal work does not require a Vitest version, installed dependencies or registered test before planning", async () => {
  const root = await mkdtemp(join(tmpdir(), "xh-native-vitest-")),
    cwd = join(root, "project"),
    home = join(root, "home");
  let service: OfficialWorkflowService | undefined;
  try {
    await mkdir(cwd);
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ type: "module", devDependencies: { vitest: "1.0.0" } }),
    );
    await writeFile(join(cwd, "add.mjs"), "export const add=(a,b)=>a-b;\n");
    await writeFile(
      join(cwd, "acceptance.test.ts"),
      "// existing TypeScript test, not pre-registered\n",
    );
    service = new OfficialWorkflowService({ home, fake: true });
    const done = service.submitSession(
      {
        sessionId: "native-vitest",
        cwd,
        model: "claude:opus",
        effort: "high",
        text: "auto-work: 加算を修正して",
        automaticWork: true,
        history: [],
      },
      new AbortController().signal,
    );
    await expect.poll(() => service!.view().approval).toBeTruthy();
    const pending = service.view(),
      record = pending.records[0]!.record;
    expect(record.nativeWork?.validation).toBe("agent-reported");
    expect(record.calls.map((c) => c.phase)).toEqual(["conversation", "plan"]);
    await service.command({
      action: "approve",
      id: pending.approval!.id,
      digest: "0".repeat(64),
    });
    expect(await readFile(join(cwd, "add.mjs"), "utf8")).toContain("a-b");
    await service.command({
      action: "approve",
      id: pending.approval!.id,
      digest: pending.approval!.digest,
    });
    expect((await done).status).toBe("completed");
    expect(await readFile(join(cwd, "add.mjs"), "utf8")).toContain("a+b");
    expect(await readFile(join(cwd, "acceptance.test.ts"), "utf8")).toContain(
      "not pre-registered",
    );
    await expect(access(join(cwd, "node_modules"))).rejects.toThrow();
    await expect(access(join(cwd, ".git"))).rejects.toThrow();
    const final = service.view().records[0]!.record;
    expect(final.project).toBeUndefined();
    expect(final.checks).toEqual([]);
    expect(final.reviews.at(-1)?.findings).toEqual([]);
    await service.close();
    service = new OfficialWorkflowService({ home, fake: true });
    const restored = await service.command({ action: "list" });
    expect(restored.records[0]?.record.nativeWork).toEqual(final.nativeWork);
    expect(restored.records[0]?.resumeBlocked).toBeTruthy();
  } finally {
    await service?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
