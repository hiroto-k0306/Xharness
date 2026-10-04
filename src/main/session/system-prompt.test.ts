import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { systemPrompt } from "./turn.js";
import { type ControllerContext } from "./context.js";
import { loadProjectConfig } from "../config/project.js";
import {
  CHILD_REPORT_GUIDANCE,
  FILE_LINK_GUIDANCE,
} from "../core/output-guidance.js";
import { ChildRunner } from "../agents/runner.js";
import { Router } from "../core/router.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { type ProviderRequest } from "../providers/provider.js";

const directories: string[] = [];
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "xh-file-guidance-"));
  directories.push(home);
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const ctx = {
    options: { home },
    clean: (text: string) => text,
  } as ControllerContext;
  return { home, cwd, ctx };
}
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
it.each(["legacy", "configured", "scratch"])(
  "always supplies application guidance without AGENTS.md: %s",
  async (mode) => {
    const { home, cwd, ctx } = await setup();
    const config = await loadProjectConfig(home);
    config.context.memoryFiles = [];
    const system = await systemPrompt(
      ctx,
      cwd,
      mode === "scratch",
      mode === "legacy" ? undefined : config,
    );
    expect(system).toContain(FILE_LINK_GUIDANCE);
    expect(system).not.toContain(CHILD_REPORT_GUIDANCE);
    expect(system).toContain("file:///D:/releases/Setup.exe");
    expect(system).toContain("Do not double-encode");
    expect(system).toContain("Never auto-run");
    expect(system.split(FILE_LINK_GUIDANCE)).toHaveLength(2);
  },
);
it.each([false, true])(
  "keeps the old system byte-identical for pre-guidance sessions (configured=%s)",
  async (configured) => {
    const { home, cwd, ctx } = await setup();
    const config = configured ? await loadProjectConfig(home) : undefined;
    if (config) config.context.memoryFiles = [];
    const current = await systemPrompt(ctx, cwd, false, config);
    const previous = await systemPrompt(ctx, cwd, false, config, false);
    expect(previous).toBe(current.replace(`\n\n${FILE_LINK_GUIDANCE}`, ""));
    expect(previous).not.toContain(FILE_LINK_GUIDANCE);
    expect(previous).toContain("Reply in Japanese unless asked otherwise.");
  },
);
it("preserves custom memory and scratch isolation while retaining common guidance", async () => {
  const { home, cwd, ctx } = await setup();
  await writeFile(join(home, "guide.md"), "home instructions");
  await writeFile(join(cwd, "guide.md"), "workspace instructions");
  const config = await loadProjectConfig(home);
  config.context.memoryFiles = ["guide.md"];
  const workspace = await systemPrompt(ctx, cwd, false, config);
  expect(workspace).toContain(FILE_LINK_GUIDANCE);
  expect(workspace).toContain("home instructions");
  expect(workspace).toContain("workspace instructions");
  const scratch = await systemPrompt(ctx, cwd, true, config);
  expect(scratch).toContain(FILE_LINK_GUIDANCE);
  expect(scratch).toContain("home instructions");
  expect(scratch).not.toContain("workspace instructions");
});
it.each(["explorer", "reviewer", "worker"])(
  "sends common and structured-output guidance to %s and preserves JSON path fields",
  async (role) => {
    const { home, cwd } = await setup();
    const requests: ProviderRequest[] = [];
    // 構造化出力の非改変と実際に送る指示を確認する。モデルの遵守保証ではない。
    const report = JSON.stringify({
      findings: [{ file: "src/main/example.ts", message: "offline finding" }],
    });
    const prompt =
      "Return only JSON with findings. Keep each file field as a relative path.";
    const provider = new FakeProvider({
      onRequest: (request) => requests.push(request),
      script: [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: report }],
          },
          stopReason: "end_turn",
        },
      ],
    });
    const runner = new ChildRunner({
      home,
      parentId: "parent",
      router: new Router([provider]),
      createTools: () => new Map(),
      permission: async () => false,
    });
    const result = await runner.run(
      role,
      { model: "claude:sonnet", tools: [] },
      prompt,
      cwd,
      new AbortController().signal,
      role === "worker" ? { files: [], reportTool: new Map() } : undefined,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.system).toContain(FILE_LINK_GUIDANCE);
    const system = requests[0]!.system;
    expect(system.split(FILE_LINK_GUIDANCE)).toHaveLength(2);
    expect(system).toContain(CHILD_REPORT_GUIDANCE);
    expect(system.split(CHILD_REPORT_GUIDANCE)).toHaveLength(2);
    expect(system).toContain(
      "takes precedence over file-link handoffs for structured output",
    );
    expect(system).toContain(
      "return only that format, without Markdown fences or extra prose",
    );
    expect(system).toContain("a review finding's file field");
    expect(system).toContain("required literal or relative paths");
    expect(system).toContain("omit progress narration");
    expect(system).toContain(
      "does not suppress required tool calls or the worker's ReportDone requirement",
    );
    expect(requests[0]!.messages[0]!.content).toEqual([
      { type: "text", text: prompt },
    ]);
    expect(result.text).toBe(report);
    expect(JSON.parse(result.text).findings[0].file).toBe(
      "src/main/example.ts",
    );
  },
  30_000,
);
