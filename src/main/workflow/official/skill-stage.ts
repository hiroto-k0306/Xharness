import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseDocument } from "yaml";
import { isSecretPath } from "../../core/sensitive-paths.js";
import type {
  OfficialSkillBundle,
  OfficialSkillSelection,
} from "../../../shared/official-skills.js";
export const skillSelection = ({
  provider,
  scope,
  name,
  source,
  hash,
  bundleHash,
}: OfficialSkillSelection): OfficialSkillSelection => ({
  provider,
  scope,
  name,
  source,
  hash,
  bundleHash,
});
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const unsupported = () => {
  throw new Error("official-skill-stage-unsupported");
};

/** Validate again at the SDK boundary; never strip unsupported native behavior. */
function validate(bundle: OfficialSkillBundle) {
  if (
    bundle.provider !== "claude" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(bundle.name) ||
    !["user", "project"].includes(bundle.scope) ||
    !isAbsolute(bundle.source) ||
    !bundle.files.length ||
    bundle.files.length > 20
  )
    unsupported();
  const seen = new Set<string>();
  let bytes = 0;
  for (const file of bundle.files) {
    const segments = file.relativePath.split("/");
    if (
      seen.has(file.relativePath) ||
      segments.length > 9 ||
      segments.some(
        (part) =>
          !part ||
          part.startsWith(".") ||
          /[:*?"<>|\\\x00-\x1f\x7f]/.test(part),
      ) ||
      isSecretPath(file.relativePath) ||
      !/\.(?:md|txt|rst)$/i.test(file.relativePath) ||
      file.body.charCodeAt(0) === 0xfeff ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(file.body) ||
      /!\s*`[^`]+`|(?:```|~~~)!/.test(file.body) ||
      hash(file.body) !== file.hash
    )
      unsupported();
    seen.add(file.relativePath);
    bytes += Buffer.byteLength(file.body);
  }
  if (bytes > 16384) unsupported();
  const main = bundle.files.find((file) => file.relativePath === "SKILL.md");
  if (!main || main.hash !== bundle.hash) unsupported();
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(main!.body);
  if (!match || Buffer.byteLength(match[0]) > 4096) unsupported();
  const doc = parseDocument(match![1]!, { uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) unsupported();
  const data: unknown = doc.toJS({ maxAliasCount: 0 });
  if (!data || typeof data !== "object" || Array.isArray(data)) unsupported();
  const metadata = data as Record<string, unknown>;
  if (
    metadata.name !== bundle.name ||
    typeof metadata.description !== "string" ||
    !metadata.description.trim() ||
    metadata.description.length > 1024 ||
    Object.keys(metadata).some(
      (key) => !["name", "description", "user-invocable"].includes(key),
    ) ||
    (Object.hasOwn(metadata, "user-invocable") &&
      metadata["user-invocable"] !== true)
  )
    unsupported();
  const files = [...bundle.files].sort((a, b) =>
    a.relativePath < b.relativePath
      ? -1
      : a.relativePath > b.relativePath
        ? 1
        : 0,
  );
  if (
    hash(
      JSON.stringify(
        files.map(({ relativePath, hash }) => ({ relativePath, hash })),
      ),
    ) !== bundle.bundleHash
  )
    unsupported();
}

/** Only selected text snapshots become plugins; no user/project settings are loaded. */
export async function stageClaudeSkills(bundles: OfficialSkillBundle[]) {
  if (
    !bundles.length ||
    bundles.length > 8 ||
    new Set(bundles.map((bundle) => bundle.name)).size !== bundles.length
  )
    unsupported();
  for (const bundle of bundles) validate(bundle);
  const root = await mkdtemp(join(tmpdir(), "xharness-selected-skills-"));
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const names = new Map<string, string>();
  const plugins: { type: "local"; path: string }[] = [];
  const cleanup = async () => {
    // The owned temporary directory only; source files are never modified.
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  };
  try {
    await chmod(root, 0o700);
    for (const [index, bundle] of bundles.entries()) {
      const pluginName = `xharness-selected-${index}`;
      const plugin = join(root, pluginName);
      const skillRoot = join(plugin, "skills", bundle.name);
      await mkdir(join(plugin, ".claude-plugin"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(plugin, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: pluginName }),
        { flag: "wx", mode: 0o400 },
      );
      for (const file of bundle.files) {
        const target = join(skillRoot, file.relativePath);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, file.body, { flag: "wx", mode: 0o400 });
        files.set(target, file.hash);
        let directory = dirname(target);
        while (directory.startsWith(skillRoot)) {
          directories.add(directory);
          if (directory === skillRoot) break;
          directory = dirname(directory);
        }
      }
      names.set(`${pluginName}:${bundle.name}`, bundle.name);
      plugins.push({ type: "local", path: plugin });
    }
    return {
      plugins,
      names,
      root,
      cleanup,
      contains: (path: string) => {
        const rel = relative(root, resolve(path));
        return (
          !rel ||
          (!isAbsolute(rel) &&
            rel !== ".." &&
            !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
        );
      },
      async intact() {
        for (const [file, expected] of files) {
          try {
            let check = file;
            while (check !== root) {
              if ((await lstat(check)).isSymbolicLink()) return false;
              check = dirname(check);
            }
            if ((await lstat(root)).isSymbolicLink()) return false;
            const info = await lstat(file);
            if (
              !info.isFile() ||
              info.nlink !== 1 ||
              hash(await readFile(file, "utf8")) !== expected
            )
              return false;
          } catch {
            return false;
          }
        }
        return true;
      },
      async readable(path: string, directoryAllowed: boolean) {
        const target = resolve(path);
        if (
          !files.has(target) &&
          !(directoryAllowed && directories.has(target))
        )
          return false;
        try {
          let check = target;
          while (check !== root) {
            if ((await lstat(check)).isSymbolicLink()) return false;
            check = dirname(check);
          }
          if ((await lstat(root)).isSymbolicLink()) return false;
          const info = await lstat(target);
          if (files.has(target))
            return (
              info.isFile() &&
              info.nlink === 1 &&
              hash(await readFile(target, "utf8")) === files.get(target)
            );
          return info.isDirectory();
        } catch {
          return false;
        }
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
