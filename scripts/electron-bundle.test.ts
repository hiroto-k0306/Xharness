import { resolveConfig } from "electron-vite";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { build, createServer } from "vite";
import { describe, expect, it } from "vitest";

describe("Electron runtime bundles", () => {
  it("serves the renderer without inline Refresh code forbidden by its CSP", async () => {
    const { config } = await resolveConfig({}, "serve");
    const target = config!.renderer!;
    const server = await createServer({
      ...target,
      configFile: false,
      logLevel: "silent",
      server: { ...target.server, middlewareMode: true },
    });
    try {
      const input = target.build!.rolldownOptions!.input as string;
      const html = await server.transformIndexHtml(
        "/",
        await readFile(input, "utf8"),
      );
      expect(html).toContain("script-src 'self'");
      expect(html).not.toContain("injectIntoGlobalHook");
      expect(server.config.server.hmr).toBe(false);
    } finally {
      await server.close();
    }
  });
  it("keeps Electron external in main and sandboxed preload", async () => {
    const { config } = await resolveConfig({}, "build");
    for (const [name, target] of [
      ["main", config!.main!],
      ["preload", config!.preload!],
    ] as const) {
      const result = await build({
        ...target,
        configFile: false,
        logLevel: "silent",
        build: { ...target.build, write: false },
      });
      const bundles = Array.isArray(result) ? result : [result];
      if (name === "main") {
        const chunks = bundles
          .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
          .filter((item) => item.type === "chunk");
        const worker = chunks.find(
          (chunk) => chunk.name === "sdk-worker" && chunk.isEntry,
        );
        expect(worker?.fileName).toBe("sdk-worker.js");
        const client = chunks.find((chunk) =>
          chunk.code.includes('new URL("./sdk-worker.js", import.meta.url)'),
        );
        expect(client).toBeDefined();
        expect(posix.dirname(client!.fileName)).toBe(
          posix.dirname(worker!.fileName),
        );
      }
      const code = bundles
        .flatMap((b) => {
          if (!("output" in b)) throw new Error("Unexpected watch build");
          return b.output;
        })
        .filter((item) => item.type === "chunk")
        .map((item) => item.code)
        .join("\n");
      // Electron's npm entry is a downloader, unavailable inside app.asar / sandbox.
      expect(code).not.toContain("function downloadElectron");
      expect(code).not.toContain("function getElectronPath");
      // The sandboxed preload cannot use Node built-ins. The main process legitimately
      // starts child processes (Bash, MCP stdio servers via the official SDK).
      if (name === "preload")
        expect(code).not.toContain('require("child_process")');
      expect(code).toMatch(/(?:from |require\()"electron"/);
    }
  });
});
