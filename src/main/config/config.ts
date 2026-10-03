import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { type ProviderId } from "../core/types.js";
import { type ReasoningEffort } from "../providers/provider.js";

/** DESIGN.md §12 の aliases の既定値。設定ファイルの aliases で上書きできる。 */
export const DEFAULT_ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-4-5-20251001",
  astra: "gpt-6-astra",
  sol: "gpt-6.1-sol",
  luna: "gpt-6-luna",
};
export const EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
export const DEFAULT_MAIN = { model: "claude:opus", effort: "high" } as const;

export interface ModelChoice {
  provider: ProviderId;
  model: string;
  effort: ReasoningEffort;
}

export function providerOfModel(model: string): ProviderId {
  return /^(gpt|o\d|codex)/i.test(model) ? "codex" : "claude";
}

/**
 * `provider:alias` / `alias` / モデル ID を、実際のモデル ID へ解決する。
 * 解決できなければ undefined。
 */
export function resolveModel(
  spec: string,
  aliases: Record<string, string> = DEFAULT_ALIASES,
): { provider: ProviderId; model: string } | undefined {
  const text = spec.trim();
  if (!text) return undefined;
  const colon = text.indexOf(":");
  const named = colon > 0 ? text.slice(0, colon) : undefined;
  if (named !== undefined && named !== "claude" && named !== "codex")
    return undefined;
  const name = colon > 0 ? text.slice(colon + 1) : text;
  if (!name) return undefined;
  const model = aliases[name] ?? name;
  const provider = named ?? providerOfModel(model);
  // `claude:gpt-6` のような食い違いは受け付けない
  if (providerOfModel(model) !== provider) return undefined;
  return { provider, model };
}

export function isEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" && (EFFORTS as readonly string[]).includes(value)
  );
}

/** DESIGN.md §22.6 の web 設定 */
export interface WebSettings {
  enabled: boolean;
  /** 従来の設定名。codexSearchMode が無いときの Codex の検索モード */
  searchMode: "live" | "cached";
  searchProvider: "auto" | "claude" | "codex";
  codexSearchMode: "live" | "cached" | "disabled";
  maxSearchesPerSession: number;
  fetch: { maxChars: number; cacheMinutes: number };
}
export const DEFAULT_WEB: WebSettings = {
  enabled: true,
  searchMode: "live",
  searchProvider: "auto",
  codexSearchMode: "live",
  maxSearchesPerSession: 100,
  fetch: { maxChars: 100000, cacheMinutes: 15 },
};

/** web 設定を読む。不正な値は既定値のまま警告に残す */
export function webSettings(
  value: unknown,
  warnings: string[] = [],
): WebSettings {
  const web: WebSettings = structuredClone(DEFAULT_WEB);
  if (!value || typeof value !== "object") return web;
  const v = value as Record<string, unknown>;
  const bad = (key: string) =>
    warnings.push(`config.yaml の web.${key} が不正です`);
  const int = (n: unknown, min: number, max: number) =>
    typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
  if (typeof v.enabled === "boolean") web.enabled = v.enabled;
  else if (v.enabled !== undefined) bad("enabled");
  if (v.searchMode === "live" || v.searchMode === "cached") {
    web.searchMode = v.searchMode;
    web.codexSearchMode = v.searchMode;
  } else if (v.searchMode !== undefined) bad("searchMode");
  if (["live", "cached", "disabled"].includes(String(v.codexSearchMode)))
    web.codexSearchMode = v.codexSearchMode as WebSettings["codexSearchMode"];
  else if (v.codexSearchMode !== undefined) bad("codexSearchMode");
  if (web.codexSearchMode !== "disabled") web.searchMode = web.codexSearchMode;
  if (["auto", "claude", "codex"].includes(String(v.searchProvider)))
    web.searchProvider = v.searchProvider as WebSettings["searchProvider"];
  else if (v.searchProvider !== undefined) bad("searchProvider");
  if (int(v.maxSearchesPerSession, 1, 1000))
    web.maxSearchesPerSession = v.maxSearchesPerSession as number;
  else if (v.maxSearchesPerSession !== undefined) bad("maxSearchesPerSession");
  if (v.fetch && typeof v.fetch === "object") {
    const f = v.fetch as Record<string, unknown>;
    if (int(f.maxChars, 1000, 1000000))
      web.fetch.maxChars = f.maxChars as number;
    else if (f.maxChars !== undefined) bad("fetch.maxChars");
    if (int(f.cacheMinutes, 0, 1440))
      web.fetch.cacheMinutes = f.cacheMinutes as number;
    else if (f.cacheMinutes !== undefined) bad("fetch.cacheMinutes");
  } else if (v.fetch !== undefined) bad("fetch");
  return web;
}

/** DESIGN.md §25 の MCP 設定(全体の on/off と上限。サーバーの定義はプロジェクトの .mcp.json) */
export interface McpSettings {
  enabled: boolean;
  startupTimeoutSec: number;
  toolTimeoutSec: number;
}
export const DEFAULT_MCP: McpSettings = {
  enabled: true,
  startupTimeoutSec: 30,
  toolTimeoutSec: 120,
};
export function mcpSettings(
  value: unknown,
  warnings: string[] = [],
): McpSettings {
  const mcp = { ...DEFAULT_MCP };
  if (!value || typeof value !== "object") return mcp;
  const v = value as Record<string, unknown>;
  const bad = (key: string) =>
    warnings.push(`config.yaml の mcp.${key} が不正です`);
  if (typeof v.enabled === "boolean") mcp.enabled = v.enabled;
  else if (v.enabled !== undefined) bad("enabled");
  for (const [key, max] of [
    ["startupTimeoutSec", 600],
    ["toolTimeoutSec", 3600],
  ] as const) {
    const n = v[key];
    if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= max)
      mcp[key] = n;
    else if (n !== undefined) bad(key);
  }
  return mcp;
}

export interface MainConfig {
  providers: { codex: { toolImageMode: "output" | "user_message" } };
  web: WebSettings;
  mcp: McpSettings;
  fallback?: Partial<Record<ProviderId, string>>;
  /** 解決済み。設定が無い・不正なら claude:opus / high */
  choice: ModelChoice;
  aliases: Record<string, string>;
  warnings: string[];
}

/**
 * グローバルと任意のプロジェクト設定をキーごとにマージして読む(§12)。
 * ファイルが無ければ既定値。不正な値は警告を付けて既定値に戻す。
 * プロジェクトの main / aliases / fallback / web の指定キーを優先する。
 */
export async function loadMainConfig(
  home: string,
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
  cwd?: string,
): Promise<MainConfig> {
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = parse(await read(join(home, "config.yaml")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT")
      warnings.push("config.yaml を読めなかったため既定値を使います");
  }
  let root = (doc && typeof doc === "object" ? doc : {}) as Record<
    string,
    unknown
  >;
  if (cwd) {
    try {
      const project: unknown = parse(
        await read(join(cwd, ".xharness", "config.yaml")),
      );
      if (project && typeof project === "object" && !Array.isArray(project)) {
        const local = project as Record<string, unknown>;
        const merged = { ...root, ...local };
        for (const key of ["main", "aliases", "fallback", "web"])
          merged[key] = {
            ...((root[key] as object) ?? {}),
            ...((local[key] as object) ?? {}),
          };
        root = merged;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT")
        warnings.push(
          "プロジェクト設定を読めなかったためグローバル設定を使います",
        );
    }
  }
  const aliases = { ...DEFAULT_ALIASES };
  if (root.aliases && typeof root.aliases === "object")
    for (const [k, v] of Object.entries(root.aliases))
      if (typeof v === "string") aliases[k] = v;
  const main = (
    root.main && typeof root.main === "object" ? root.main : {}
  ) as Record<string, unknown>;
  let resolved = resolveModel(DEFAULT_MAIN.model, aliases)!;
  if (main.model !== undefined) {
    const r =
      typeof main.model === "string"
        ? resolveModel(main.model, aliases)
        : undefined;
    if (r) resolved = r;
    else
      warnings.push(
        "config.yaml の main.model を解決できないため claude:opus を使います",
      );
  }
  let effort: ReasoningEffort = DEFAULT_MAIN.effort;
  if (main.effort !== undefined) {
    if (isEffort(main.effort)) effort = main.effort;
    else
      warnings.push("config.yaml の main.effort が不正なため high を使います");
  }
  const fallback: Partial<Record<ProviderId, string>> = {
    claude: "codex:sol",
    codex: "claude:sonnet",
  };
  if (root.fallback && typeof root.fallback === "object") {
    for (const provider of ["claude", "codex"] as const) {
      const spec = (root.fallback as Record<string, unknown>)[provider];
      if (spec === null || spec === false) delete fallback[provider];
      else if (typeof spec === "string" && resolveModel(spec, aliases))
        fallback[provider] = spec;
      else if (spec !== undefined)
        warnings.push(`config.yaml の fallback.${provider} が不正です`);
    }
  }
  const web = webSettings(root.web, warnings);
  const mcp = mcpSettings(root.mcp, warnings);
  const mode = (
    root.providers as { codex?: { toolImageMode?: unknown } } | undefined
  )?.codex?.toolImageMode;
  if (mode !== undefined && mode !== "output" && mode !== "user_message")
    warnings.push("config.yaml の providers.codex.toolImageMode が不正です");
  const providers: MainConfig["providers"] = {
    codex: { toolImageMode: mode === "user_message" ? mode : "output" },
  };
  return {
    choice: { ...resolved, effort },
    aliases,
    warnings,
    fallback,
    web,
    mcp,
    providers,
  };
}

/**
 * 起動時の既定モデルを決める。優先順位: --model(--effort) > 設定ファイル > claude:opus / high。
 * このビルドが扱えないプロバイダ(Codex は Phase 3)は既定値へ戻して警告する。
 */
export async function resolveStartup(opts: {
  home: string;
  cliModel?: string;
  cliEffort?: string;
  supported: readonly ProviderId[];
  read?: (path: string) => Promise<string>;
}): Promise<MainConfig> {
  const cfg = await loadMainConfig(opts.home, opts.read);
  const warnings = [...cfg.warnings];
  let choice = cfg.choice;
  if (!opts.supported.includes(choice.provider)) {
    warnings.push(
      `${choice.provider} はまだ使えないため claude:opus を使います`,
    );
    choice = { ...choice, ...resolveModel(DEFAULT_MAIN.model)! };
  }
  if (opts.cliModel !== undefined) {
    const r = resolveModel(opts.cliModel, cfg.aliases);
    if (!r) throw new Error(`--model を解決できません: ${opts.cliModel}`);
    if (!opts.supported.includes(r.provider))
      throw new Error(`${r.provider} はまだ使えません(Phase 3)`);
    choice = { ...choice, ...r };
  }
  if (opts.cliEffort !== undefined) {
    if (!isEffort(opts.cliEffort))
      throw new Error(`--effort は ${EFFORTS.join(" / ")} のいずれか`);
    choice = { ...choice, effort: opts.cliEffort };
  }
  return {
    choice,
    aliases: cfg.aliases,
    warnings,
    fallback: cfg.fallback,
    web: cfg.web,
    mcp: cfg.mcp,
    providers: cfg.providers,
  };
}

/** `--fake` / `--devtools` / `--model <spec>` / `--effort <level>`(`--model=spec` も可)を取り出す。 */
export function parseStartupArgs(argv: readonly string[]): {
  fake: boolean;
  /** パッケージ版でも Ctrl+Shift+I で DevTools を開けるようにする(診断用) */
  devtools: boolean;
  model?: string;
  effort?: string;
  resume?: string;
} {
  const value = (name: string): string | undefined => {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === name) return argv[i + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
    return undefined;
  };
  return {
    fake: argv.includes("--fake"),
    devtools: argv.includes("--devtools"),
    model: value("--model"),
    effort: value("--effort"),
    resume: value("--resume"),
  };
}
