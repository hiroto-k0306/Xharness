// .mcp.json(リポジトリ直下、Claude Code と同じ形式)の読み込み。DESIGN.md §25.2
// electron を import しない。
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface McpServerConfig {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** 展開前の定義のハッシュ(承認の鍵。定義が変わったら再承認) */
  hash: string;
}

export interface McpConfig {
  /** .mcp.json があったか(MCP のツールを tools に加えるかの判断に使う) */
  exists: boolean;
  servers: McpServerConfig[];
  warnings: string[];
}

export const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** `${VAR}` / `${VAR:-既定値}` を展開する。未定義で既定値も無い変数は missing に入れる */
export function expandVars(
  value: string,
  env: NodeJS.ProcessEnv,
  missing: Set<string>,
): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_all, name: string, fallback: string | undefined) => {
      const found = env[name];
      if (found !== undefined && found !== "") return found;
      if (fallback !== undefined) return fallback;
      missing.add(name);
      return "";
    },
  );
}

function stringRecord(value: unknown): Record<string, string> | false {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, v]) => typeof v !== "string")) return false;
  return Object.fromEntries(entries) as Record<string, string>;
}

/** 承認画面に出す内容。env / headers は値を出さず、キー名だけにする */
export function displayServer(server: McpServerConfig) {
  return {
    name: server.name,
    type: server.type,
    ...(server.type === "stdio"
      ? {
          command: server.command,
          args: server.args ?? [],
          envKeys: Object.keys(server.env ?? {}),
        }
      : {
          url: server.url,
          headerKeys: Object.keys(server.headers ?? {}),
        }),
  };
}

export function parseMcpConfig(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): Omit<McpConfig, "exists"> {
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { servers: [], warnings: [".mcp.json を読めません(JSON の形式)"] };
  }
  const list =
    doc && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>).mcpServers
      : undefined;
  if (!list || typeof list !== "object" || Array.isArray(list))
    return {
      servers: [],
      warnings: [".mcp.json に mcpServers がありません"],
    };
  const servers: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(list as Record<string, unknown>)) {
    const bad = (why: string) =>
      warnings.push(`.mcp.json のサーバー ${name.slice(0, 64)}: ${why}`);
    if (!SERVER_NAME.test(name) || name.includes("__")) {
      bad("名前は英数字・_・- の64文字以内で、__ を含められません");
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      bad("定義がオブジェクトではありません");
      continue;
    }
    const def = raw as Record<string, unknown>;
    const type = def.type ?? "stdio";
    const hash = createHash("sha256")
      .update(JSON.stringify([name, def]))
      .digest("hex")
      .slice(0, 32);
    const missing = new Set<string>();
    const expand = (s: string) => expandVars(s, env, missing);
    if (type === "sse") {
      bad("sse は非推奨のため読みません(http を使ってください)");
      continue;
    }
    if (type === "stdio") {
      const envs = stringRecord(def.env);
      if (
        typeof def.command !== "string" ||
        !def.command.trim() ||
        (def.args !== undefined &&
          (!Array.isArray(def.args) ||
            def.args.some((a) => typeof a !== "string"))) ||
        envs === false
      ) {
        bad("command(文字列)・args(文字列の配列)・env(文字列の値)が必要です");
        continue;
      }
      const server: McpServerConfig = {
        name,
        type: "stdio",
        command: expand(def.command),
        args: ((def.args as string[] | undefined) ?? []).map(expand),
        env: Object.fromEntries(
          Object.entries(envs).map(([k, v]) => [k, expand(v)]),
        ),
        hash,
      };
      if (missing.size) {
        bad(`環境変数 ${[...missing].join(", ")} が未定義のため無効にしました`);
        continue;
      }
      servers.push(server);
    } else if (type === "http") {
      const headers = stringRecord(def.headers);
      if (typeof def.url !== "string" || headers === false) {
        bad("url(文字列)・headers(文字列の値)が必要です");
        continue;
      }
      const url = expand(def.url);
      let parsed: URL | undefined;
      try {
        parsed = new URL(url);
      } catch {
        /* 下で警告する */
      }
      if (!parsed || !["https:", "http:"].includes(parsed.protocol)) {
        bad("url は http(s) の URL にしてください");
        continue;
      }
      const server: McpServerConfig = {
        name,
        type: "http",
        url,
        headers: Object.fromEntries(
          Object.entries(headers).map(([k, v]) => [k, expand(v)]),
        ),
        hash,
      };
      if (missing.size) {
        bad(`環境変数 ${[...missing].join(", ")} が未定義のため無効にしました`);
        continue;
      }
      servers.push(server);
    } else bad(`未対応の type です: ${String(type).slice(0, 20)}`);
  }
  return { servers, warnings };
}

export async function loadMcpConfig(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpConfig> {
  let text: string;
  try {
    text = await readFile(join(root, ".mcp.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { exists: false, servers: [], warnings: [] };
    return { exists: true, servers: [], warnings: [".mcp.json を読めません"] };
  }
  return { exists: true, ...parseMcpConfig(text, env) };
}
