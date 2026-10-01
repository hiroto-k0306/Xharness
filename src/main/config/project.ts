import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  permissionModes,
  rules,
  type PermissionConfig,
  type Rule,
} from "../core/permissions.js";
import { randomUUID } from "node:crypto";
import { FileAccess } from "../tools/files.js";
export interface ProjectConfig {
  permissions: PermissionConfig;
  context: { compactThreshold: number; memoryFiles: string[] };
}
async function document(path: string): Promise<Record<string, unknown>> {
  try {
    const doc: unknown = parse(await readFile(path, "utf8"));
    return doc && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Configuration could not be read");
  }
}
export async function loadProjectConfig(
  home: string,
  cwd?: string,
): Promise<ProjectConfig> {
  const documents = [
    await document(join(home, "config.yaml")),
    ...(cwd ? [await document(join(cwd, ".xharness", "config.yaml"))] : []),
  ];
  const result: ProjectConfig = {
    permissions: { mode: "default", rules: [] },
    context: { compactThreshold: 0.8, memoryFiles: ["AGENTS.md", "CLAUDE.md"] },
  };
  for (const doc of documents) {
    if (doc.permissions && typeof doc.permissions === "object") {
      const p = doc.permissions as Record<string, unknown>;
      if (permissionModes.includes(p.mode as PermissionConfig["mode"]))
        result.permissions.mode = p.mode as PermissionConfig["mode"];
      result.permissions.rules.push(...rules(p.rules));
    }
    if (doc.context && typeof doc.context === "object") {
      const c = doc.context as Record<string, unknown>;
      if (
        typeof c.compactThreshold === "number" &&
        c.compactThreshold > 0 &&
        c.compactThreshold < 1
      )
        result.context.compactThreshold = c.compactThreshold;
      if (
        Array.isArray(c.memoryFiles) &&
        c.memoryFiles.every((f) => typeof f === "string" && f.length <= 512)
      )
        result.context.memoryFiles = c.memoryFiles;
    }
  }
  return result;
}
const chains = new Map<string, Promise<void>>();
export async function saveRule(home: string, rule: Rule): Promise<void> {
  const path = join(home, "config.yaml");
  const job = (chains.get(path) ?? Promise.resolve()).then(async () => {
    const doc = await document(path);
    const permissions =
      doc.permissions && typeof doc.permissions === "object"
        ? (doc.permissions as Record<string, unknown>)
        : {};
    doc.permissions = {
      ...permissions,
      rules: [...rules(permissions.rules), rule],
    };
    await mkdir(home, { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, stringify(doc), "utf8");
    await rename(temp, path);
  });
  chains.set(
    path,
    job.catch(() => undefined),
  );
  return job;
}
export async function projectMemory(
  home: string,
  cwd: string | undefined,
  files: string[],
): Promise<string> {
  const paths = [
    ...files.map((f) => join(home, f)),
    ...(cwd ? files.map((f) => join(cwd, f)) : []),
  ];
  const contents: string[] = [];
  for (const path of new Set(paths)) {
    try {
      const checked = await new FileAccess(home).path(path);
      if (
        /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|id_rsa|id_ed25519)$/i.test(checked)
      )
        throw new Error("Secret files cannot be project memory");
      contents.push(
        `${path}:\n${(await readFile(checked, "utf8")).slice(0, 64000)}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Project memory could not be read");
    }
  }
  return contents.join("\n\n");
}
