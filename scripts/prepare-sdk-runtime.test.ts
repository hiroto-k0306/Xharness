import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { validateSdkTree } from "../src/main/workflow/official/sdk-install.js";

it("ships SDK types and required peers outside ASAR and replaces only the seed output", async () => {
  const root = await mkdtemp(join(tmpdir(), "xh-packaged-sdk-"));
  try {
    const { default: prepare } = await import("./prepare-sdk-runtime.mjs");
    await prepare({ packager: { info: { appDir: root } } });
    const seed = join(root, ".out/claude-sdk-seed");
    const entry = await validateSdkTree(seed, "0.3.290");
    const require = createRequire(entry);
    const peer = await realpath(require.resolve("@anthropic-ai/sdk"));
    expect(peer.startsWith(seed)).toBe(true);
    expect(
      await readFile(
        join(seed, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts"),
        "utf8",
      ),
    ).toContain("supportedModels");
    await prepare({ packager: { info: { appDir: root } } });
    expect(await validateSdkTree(seed, "0.3.290")).toBe(entry);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
