import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { redact } from "../core/redact.js";
import {
  decidePermission,
  grantFor,
  normalizeCall,
} from "../core/permissions.js";
import { McpApprovals } from "./approvals.js";
import {
  displayServer,
  loadMcpConfig,
  parseMcpConfig,
  type McpServerConfig,
} from "./config.js";
import { formatCallResult, McpManager } from "./manager.js";

const FIXTURE = fileURLToPath(
  new URL("../../../test/fixtures/mcp/server.mjs", import.meta.url),
);
const signal = () => new AbortController().signal;
const fixtureServer = (
  name = "fx",
  env: Record<string, string> = {},
): McpServerConfig => ({
  name,
  type: "stdio",
  command: process.execPath,
  args: [FIXTURE],
  env,
  hash: "h-" + name,
});

describe(".mcp.json (§25.2)", () => {
  it("reads stdio and http servers and expands ${VAR} and ${VAR:-default}", () => {
    const { servers, warnings } = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          db: {
            command: "npx",
            args: ["-y", "srv", "${DIR}"],
            env: { URL: "${DB_URL:-sqlite://x}", TOKEN: "${TOKEN}" },
          },
          web: {
            type: "http",
            url: "https://${HOST}/mcp",
            headers: { Authorization: "Bearer ${TOKEN}" },
          },
        },
      }),
      { DIR: "/work", TOKEN: "t0ken-value", HOST: "example.com" },
    );
    expect(warnings).toEqual([]);
    expect(servers[0]).toMatchObject({
      name: "db",
      type: "stdio",
      command: "npx",
      args: ["-y", "srv", "/work"],
      env: { URL: "sqlite://x", TOKEN: "t0ken-value" },
    });
    expect(servers[1]).toMatchObject({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer t0ken-value" },
    });
    // 承認画面にはキー名だけ(値は出さない)
    expect(JSON.stringify(servers.map(displayServer))).not.toContain(
      "t0ken-value",
    );
    expect(displayServer(servers[1]!)).toMatchObject({
      headerKeys: ["Authorization"],
    });
  });
  it("disables servers with undefined variables, bad names, sse and bad shapes", () => {
    const { servers, warnings } = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          missing: { command: "x", env: { A: "${NOPE}" } },
          bad__name: { command: "x" },
          "bad name": { command: "x" },
          old: { type: "sse", url: "https://example.com" },
          noCommand: { args: ["x"] },
          badArgs: { command: "x", args: "y" },
          file: { type: "http", url: "file:///etc/passwd" },
          ok: { command: "x" },
        },
      }),
      {},
    );
    expect(servers.map((s) => s.name)).toEqual(["ok"]);
    expect(warnings).toHaveLength(7);
    expect(warnings.join("\n")).toContain("NOPE");
  });
  it("hashes the unexpanded definition so a changed definition needs approval again", () => {
    const text = (cmd: string) =>
      JSON.stringify({
        mcpServers: { a: { command: cmd, env: { K: "${V}" } } },
      });
    const one = parseMcpConfig(text("x"), { V: "1" }).servers[0]!;
    const sameDefOtherEnv = parseMcpConfig(text("x"), { V: "2" }).servers[0]!;
    const changed = parseMcpConfig(text("y"), { V: "1" }).servers[0]!;
    expect(one.hash).toBe(sameDefOtherEnv.hash);
    expect(one.hash).not.toBe(changed.hash);
  });
  it("reports whether .mcp.json exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-mcp-root-"));
    expect((await loadMcpConfig(root)).exists).toBe(false);
    await writeFile(join(root, ".mcp.json"), "{not json");
    const broken = await loadMcpConfig(root);
    expect(broken.exists).toBe(true);
    expect(broken.warnings).toHaveLength(1);
  });
});

describe("approvals (§25.3)", () => {
  it("stores decisions outside the repository by definition hash", async () => {
    const home = await mkdtemp(join(tmpdir(), "xh-mcp-home-"));
    const root = await mkdtemp(join(tmpdir(), "xh-mcp-root-"));
    const approvals = await McpApprovals.open(home, root);
    expect(await approvals.get("a", "h1")).toBeUndefined();
    await approvals.set("a", "h1", "approved");
    await approvals.set("b", "h2", "rejected");
    const again = await McpApprovals.open(home, root);
    expect(await again.get("a", "h1")).toBe("approved");
    expect(await again.get("a", "h-changed")).toBeUndefined();
    expect(await again.get("b", "h2")).toBe("rejected");
    await again.reset("b");
    expect(await again.get("b", "h2")).toBeUndefined();
  });
});

describe("McpManager with a real stdio server", () => {
  let manager: McpManager | undefined;
  afterEach(async () => {
    await manager?.close();
    manager = undefined;
  });
  it("lists tools, calls them, passes env and masks stderr", async () => {
    const secret = "fixture-secret-value-123";
    const logs: string[] = [];
    manager = new McpManager({
      cwd: process.cwd(),
      redact: (t) => redact(t, [secret]),
      log: (_server, text) => logs.push(text),
    });
    await manager.connect(
      [fixtureServer("fx", { FIXTURE_SECRET: secret })],
      signal(),
    );
    expect(manager.states()).toEqual([
      {
        name: "fx",
        type: "stdio",
        status: "connected",
        tools: 6,
        resources: 2,
        prompts: 1,
      },
    ]);
    expect(manager.tools().map((t) => t.name)).toEqual([
      "add",
      "big",
      "echo",
      "env",
      "fail",
      "toggle",
    ]);
    expect(await manager.call("fx", "echo", { text: "hi" }, signal())).toEqual({
      text: "hi",
      isError: false,
    });
    expect(
      (await manager.call("fx", "add", { a: 1, b: 2 }, signal())).text,
    ).toBe("3\n[unsupported content: image]");
    expect(await manager.call("fx", "fail", {}, signal())).toEqual({
      text: "it failed",
      isError: true,
    });
    expect((await manager.call("fx", "env", {}, signal())).text).toBe(secret);
    expect((await manager.call("fx", "nope", {}, signal())).isError).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(logs.join("")).toContain("fixture started");
    expect(logs.join("")).not.toContain(secret);
  }, 30_000);
  it("marks crashed and slow servers as failed and keeps the others", async () => {
    manager = new McpManager({ cwd: process.cwd(), startupTimeoutMs: 2000 });
    await manager.connect(
      [
        fixtureServer("crash", { FIXTURE_MODE: "crash" }),
        fixtureServer("slow", { FIXTURE_MODE: "slow" }),
        fixtureServer("ok"),
      ],
      signal(),
    );
    const states = Object.fromEntries(
      manager.states().map((s) => [s.name, s.status]),
    );
    expect(states).toEqual({
      crash: "failed",
      slow: "failed",
      ok: "connected",
    });
    expect(manager.states().find((s) => s.name === "slow")!.error).toContain(
      "時間内",
    );
    expect(manager.servers()).toEqual(["ok"]);
  }, 30_000);
});

describe("result formatting", () => {
  it("keeps text and embedded text resources and names other content", () => {
    expect(
      formatCallResult({
        content: [
          { type: "text", text: "a" },
          { type: "resource", resource: { uri: "file:///x", text: "body" } },
          { type: "resource", resource: { uri: "file:///y", blob: "AA" } },
          { type: "resource_link", uri: "file:///z" },
          { type: "audio", data: "AA" },
        ],
      }),
    ).toBe(
      "a\n[resource file:///x]\nbody\n[unsupported content: binary resource file:///y]\n[resource link file:///z]\n[unsupported content: audio]",
    );
    expect(formatCallResult({ structuredContent: { n: 1 } })).toBe('{"n":1}');
  });
});

describe("MCP permissions (§25.5)", () => {
  const mcpCall = (server: string, tool: string) => ({
    id: "t",
    name: "McpCall",
    input: { server, tool, input: {} },
  });
  const cwd = process.cwd();
  it("asks by default, and a saved grant is the real tool name", async () => {
    const call = mcpCall("github", "create_issue");
    expect(
      await decidePermission(call, { mode: "default", rules: [] }, cwd),
    ).toBe("ask");
    const grant = grantFor(await normalizeCall(call, cwd));
    expect(grant).toEqual({
      tool: "mcp__github__create_issue",
      decision: "allow",
    });
    const config = { mode: "default" as const, rules: [grant] };
    expect(await decidePermission(call, config, cwd)).toBe("allow");
    expect(
      await decidePermission(mcpCall("github", "delete_repo"), config, cwd),
    ).toBe("ask");
  });
  it("treats mcp__server and mcp__server__* as the whole server, and deny wins", async () => {
    for (const tool of ["mcp__github", "mcp__github__*"]) {
      const config = {
        mode: "default" as const,
        rules: [{ tool, decision: "allow" as const }],
      };
      expect(await decidePermission(mcpCall("github", "x"), config, cwd)).toBe(
        "allow",
      );
      expect(await decidePermission(mcpCall("githubx", "x"), config, cwd)).toBe(
        "ask",
      );
    }
    // ツール1つのルールは、名前の前方一致でほかのツールへ広がらない
    expect(
      await decidePermission(
        mcpCall("github", "create__x"),
        {
          mode: "default",
          rules: [{ tool: "mcp__github__create", decision: "allow" }],
        },
        cwd,
      ),
    ).toBe("ask");
    expect(
      await decidePermission(
        mcpCall("github", "x"),
        {
          mode: "default",
          rules: [
            { tool: "mcp__github", decision: "allow" },
            { tool: "mcp__github__x", decision: "deny" },
          ],
        },
        cwd,
      ),
    ).toBe("deny");
  });
  it("never auto-allows in acceptEdits and denies in plan / read-only", async () => {
    expect(
      await decidePermission(
        mcpCall("a", "b"),
        { mode: "acceptEdits", rules: [] },
        cwd,
      ),
    ).toBe("ask");
    const allow = [{ tool: "mcp__a", decision: "allow" as const }];
    expect(
      await decidePermission(
        mcpCall("a", "b"),
        { mode: "plan", rules: allow },
        cwd,
      ),
    ).toBe("deny");
    expect(
      await decidePermission(
        mcpCall("a", "b"),
        { mode: "default", rules: allow },
        cwd,
        { readOnly: true },
      ),
    ).toBe("deny");
  });
});

describe("process cleanup", () => {
  it("does not leave a server process behind after a startup timeout", async () => {
    const { sdkConnector } = await import("./manager.js");
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const pidFile = join(await mkdtemp(join(tmpdir(), "xh-mcp-pid-")), "pid");
    const server = fixtureServer("slow", {
      FIXTURE_MODE: "slow",
      FIXTURE_PID_FILE: pidFile,
    });
    await expect(
      sdkConnector(server, {
        cwd: process.cwd(),
        onStderr: () => {},
        onListChanged: () => {},
        signal: AbortSignal.timeout(1500),
        outer: new AbortController().signal,
      }),
    ).rejects.toThrow();
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    // process.kill(pid, 0) は送らずに存在だけを確かめる(Windows でも同じ)。EPERM は存在している
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    const end = Date.now() + 8000;
    while (alive() && Date.now() < end)
      await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
  }, 20_000);
});

describe("resources, prompts and list_changed (§25 M2)", () => {
  let manager: McpManager | undefined;
  afterEach(async () => {
    await manager?.close();
    manager = undefined;
  });
  it("lists and reads resources and expands prompts", async () => {
    manager = new McpManager({ cwd: process.cwd() });
    await manager.connect([fixtureServer("fx")], signal());
    expect(manager.resources().map((r) => r.uri)).toEqual([
      "fixture://logo",
      "fixture://readme",
    ]);
    expect(await manager.read("fx", "fixture://readme", signal())).toEqual({
      text: "Fixture README",
      isError: false,
    });
    expect((await manager.read("fx", "fixture://logo", signal())).text).toBe(
      "[unsupported content: binary resource fixture://logo (image/png)]",
    );
    expect(manager.prompts()[0]).toMatchObject({
      server: "fx",
      name: "review",
      arguments: [
        { name: "file", required: true },
        { name: "focus", required: false },
      ],
    });
    expect(
      await manager.prompt("fx", "review", { file: "a.ts" }, signal()),
    ).toBe("Review a.ts");
  }, 30_000);
  it("refreshes lists on list_changed and reports what changed once", async () => {
    const changed: string[] = [];
    manager = new McpManager({
      cwd: process.cwd(),
      onChange: (c) => changed.push(c.kind),
    });
    await manager.connect([fixtureServer("fx")], signal());
    expect(manager.find("fx", "extra")).toBeUndefined();
    await manager.call("fx", "toggle", {}, signal());
    const end = Date.now() + 5000;
    while (changed.length < 2 && Date.now() < end)
      await new Promise((r) => setTimeout(r, 20));
    expect(manager.find("fx", "extra")).toBeDefined();
    expect(manager.resources().map((r) => r.uri)).toContain("fixture://extra");
    expect(manager.states()[0]).toMatchObject({ tools: 7, resources: 3 });
    expect(manager.takeChanges()).toEqual([
      { server: "fx", kind: "tools", added: ["extra"], removed: [] },
      {
        server: "fx",
        kind: "resources",
        added: ["fixture://extra"],
        removed: [],
      },
    ]);
    expect(manager.takeChanges()).toEqual([]);
  }, 30_000);
});

describe("MCP resource permissions (§25.5)", () => {
  const cwd = process.cwd();
  const read = (server: string) => ({
    id: "r",
    name: "ReadMcpResource",
    input: { server, uri: "x://y" },
  });
  it("search and listing need no approval; reading asks first and 'always' is per server", async () => {
    for (const name of ["McpSearch", "ListMcpResources"])
      expect(
        await decidePermission(
          { id: "s", name, input: {} },
          { mode: "plan", rules: [] },
          cwd,
        ),
      ).toBe("allow");
    expect(
      await decidePermission(read("fx"), { mode: "default", rules: [] }, cwd),
    ).toBe("ask");
    const grant = grantFor(await normalizeCall(read("fx"), cwd));
    expect(grant).toEqual({
      tool: "ReadMcpResource",
      pattern: "fx",
      decision: "allow",
    });
    // 読み取りなので plan でも使える(ルールがあれば確認なし)
    expect(
      await decidePermission(read("fx"), { mode: "plan", rules: [grant] }, cwd),
    ).toBe("allow");
    expect(
      await decidePermission(
        read("other"),
        { mode: "default", rules: [grant] },
        cwd,
      ),
    ).toBe("ask");
    expect(
      await decidePermission(
        read("fx"),
        {
          mode: "default",
          rules: [grant, { tool: "ReadMcpResource", decision: "deny" }],
        },
        cwd,
      ),
    ).toBe("deny");
  });
});
