import { it, expect } from "vitest";
import { loadModelCatalog } from "../main/config/model-catalog.js";
import { WorkflowRuntime } from "../main/workflow/runtime.js";
import { loadAgentConfig } from "../main/agents/definitions.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../main/core/router.js";
import { FakeProvider } from "../main/providers/fake/fake-provider.js";
it("catalog and workflow can execute through the main-process bridge in jsdom", async () => {
  expect(loadModelCatalog().length).toBeGreaterThan(0);
  const cwd = await mkdtemp(join(tmpdir(), "xh-jsdom-"));
  const provider = new FakeProvider();
  const runtime = new WorkflowRuntime({
    home: cwd,
    cwd,
    parentId: "test",
    config: await loadAgentConfig(cwd),
    router: new Router([provider]),
    createTools: () => new Map(),
    permission: async () => true,
    approve: async () => true,
  });
  expect(
    (
      await runtime.run(
        {
          provider,
          model: "fake",
          system: "test",
          messages: [],
          tools: new Map(),
          permission: async () => true,
        },
        new AbortController().signal,
      )
    ).stopCause,
  ).toBe("end_turn");
});
