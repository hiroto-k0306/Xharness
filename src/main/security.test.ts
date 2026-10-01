import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isExternalHttps, secureWebPreferences } from "./security.js";

describe("renderer security settings (DESIGN §14)", () => {
  it("isolates the renderer: contextIsolation, no node, sandbox", () => {
    expect(secureWebPreferences("/p/preload.cjs")).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: "/p/preload.cjs",
    });
  });
  it("only https links may be opened externally", () => {
    expect(isExternalHttps("https://example.com/a")).toBe(true);
    for (const bad of [
      "http://example.com",
      "file:///C:/x",
      "javascript:alert(1)",
      "not a url",
      "",
    ])
      expect(isExternalHttps(bad)).toBe(false);
  });
  it("the page CSP forbids remote and inline script", async () => {
    const html = await readFile("src/renderer/index.html", "utf8");
    const csp =
      /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-eval|https?:|\*/);
    expect(csp).toContain("connect-src 'none'");
  });
  it("preload exposes only command() and onEvent(), never ipcRenderer or credentials", async () => {
    const src = await readFile("src/preload/index.ts", "utf8");
    expect(src.match(/exposeInMainWorld\(/g)).toHaveLength(1);
    expect(src).toMatch(/exposeInMainWorld\("harness", api\)/);
    expect(src).not.toMatch(/exposeInMainWorld\("[^"]+",\s*ipcRenderer/);
    expect(src).not.toMatch(/credentials|auth\.json|readFile|process\.env/);
  });
  it("the renderer never imports electron, node builtins, or the credential modules", async () => {
    const { readdir } = await import("node:fs/promises");
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const path = `${dir}/${e.name}`;
        if (e.isDirectory()) await walk(path);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name))
          files.push(path);
      }
    };
    await walk("src/renderer");
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const text = await readFile(f, "utf8");
      expect(text, f).not.toMatch(/from "(electron|node:[^"]+|fs|path)"/);
      expect(text, f).not.toMatch(/main\/auth|local-secrets|claude-oauth/);
    }
  });
});
