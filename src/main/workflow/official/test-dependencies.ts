import {
  lstat,
  readdir,
  readFile,
  realpath,
  mkdir,
  copyFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { join, relative, isAbsolute, dirname, resolve } from "node:path";
import { WorkflowFailure, relativeFile } from "./contracts.js";

const hash = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");
const packageName = /^(@[a-z0-9._-]+\/)?[a-z0-9_-][a-z0-9._-]*$/i;
const inside = (root: string, path: string) => {
  const r = relative(root, path);
  return !r || (!r.startsWith("..") && !isAbsolute(r));
};
export interface DependencySnapshot {
  fingerprint: string;
  packages: { name: string; version: string }[];
  bytes: number;
  files: number;
}
/** Read installed dependencies only. Materialize copies, never execute npm/pnpm scripts. */
export async function testDependencies(
  cwd: string,
  roots: string[],
  signal: AbortSignal,
) {
  const modules = join(cwd, "node_modules");
  const boundary = await realpath(modules).catch(() => {
    throw new WorkflowFailure("installed-test-dependency-required");
  });
  if (
    (await lstat(modules)).isSymbolicLink() ||
    resolve(modules).toLowerCase() !== boundary.toLowerCase()
  )
    throw new WorkflowFailure("linked-test-dependencies");
  const files: { from: string; to: string; hash: string; bytes: number }[] = [],
    packages: DependencySnapshot["packages"] = [],
    seen = new Set<string>();
  let bytes = 0;
  async function locate(name: string, from: string) {
    if (
      !packageName.test(name) ||
      name
        .split("/")
        .some(
          (p) =>
            /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(p),
        )
    )
      throw new WorkflowFailure("invalid-test-dependency");
    for (const dir of createRequire(join(from, "package.json")).resolve.paths(
      name,
    ) ?? []) {
      const path = join(dir, name);
      try {
        const actual = await realpath(path);
        if (!inside(boundary, actual))
          throw new WorkflowFailure("external-test-dependency");
        const meta = await lstat(join(actual, "package.json"));
        if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 1048576)
          throw new WorkflowFailure("invalid-test-dependency");
        const pkg = JSON.parse(
          await readFile(join(actual, "package.json"), "utf8"),
        );
        if (pkg.name === name) return { actual, pkg };
      } catch (e) {
        if (e instanceof WorkflowFailure) throw e;
        if (
          !["ENOENT", "ENOTDIR"].includes(
            (e as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw new WorkflowFailure("invalid-test-dependency");
      }
    }
    throw new WorkflowFailure("installed-test-dependency-required");
  }
  const destinations = new Map<string, string>();
  async function add(name: string, from: string, parentModules: string) {
    signal.throwIfAborted();
    const { actual, pkg } = await locate(name, from),
      key = actual.toLowerCase();
    const previous = destinations.get(name);
    const destination =
      previous && previous !== key
        ? join(parentModules, name)
        : join("node_modules", name);
    const identity = key + "|" + destination;
    if (seen.has(identity)) return;
    // Reuse an ancestor/global copy for dependency cycles, as Node resolution does.
    if (previous === key) return;
    seen.add(identity);
    if (!previous) destinations.set(name, key);
    if (
      packages.length >= 256 ||
      typeof pkg.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(pkg.version)
    )
      throw new WorkflowFailure("test-dependency-limit");
    packages.push({ name, version: pkg.version });
    async function walk(path: string, to: string, depth: number) {
      signal.throwIfAborted();
      if (!relativeFile.safeParse(to.replaceAll("\\", "/")).success)
        throw new WorkflowFailure("unsafe-test-dependency-file");
      if (depth > 30) throw new WorkflowFailure("test-dependency-limit");
      const actualFile = await realpath(path);
      if (!inside(actual, actualFile))
        throw new WorkflowFailure("linked-package-file");
      const stat = await lstat(path);
      if (stat.isSymbolicLink())
        throw new WorkflowFailure("linked-package-file");
      if (stat.isDirectory()) {
        for (const f of await readdir(path))
          if (f !== "node_modules")
            await walk(join(path, f), join(to, f), depth + 1);
        return;
      }
      if (
        !stat.isFile() ||
        stat.size > 134217728 ||
        files.length >= 20000 ||
        bytes + stat.size > 536870912
      )
        throw new WorkflowFailure("test-dependency-limit");
      const data = await readFile(path);
      bytes += data.length;
      files.push({ from: path, to, hash: hash(data), bytes: data.length });
    }
    await walk(actual, destination, 0);
    const dependencies = {
      ...pkg.dependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    };
    for (const child of Object.keys(dependencies)) {
      try {
        const found = await locate(child, actual);
        const accepts = (list: string[] | undefined, current: string) =>
          !list ||
          (!list.includes(`!${current}`) &&
            (!list.some((v) => !v.startsWith("!")) || list.includes(current)));
        if (
          !accepts(found.pkg.os, process.platform) ||
          !accepts(found.pkg.cpu, process.arch)
        )
          continue;
        await add(child, actual, join(destination, "node_modules"));
      } catch (e) {
        if (
          e instanceof WorkflowFailure &&
          e.message === "installed-test-dependency-required" &&
          (pkg.optionalDependencies?.[child] ||
            pkg.peerDependenciesMeta?.[child]?.optional)
        )
          continue;
        throw e;
      }
    }
  }
  for (const name of [...new Set(roots)].sort())
    await add(name, cwd, "node_modules");
  files.sort((a, b) => a.to.localeCompare(b.to, "en"));
  const snapshot: DependencySnapshot = {
    fingerprint: hash(
      JSON.stringify(files.map(({ to, hash }) => ({ to, hash }))),
    ),
    packages,
    bytes,
    files: files.length,
  };
  async function checkSource() {
    for (const f of files) {
      signal.throwIfAborted();
      if (
        (await lstat(f.from)).isSymbolicLink() ||
        (await realpath(f.from)).toLowerCase() !==
          resolve(f.from).toLowerCase() ||
        hash(await readFile(f.from)) !== f.hash
      )
        throw new WorkflowFailure("test-dependencies-changed");
    }
  }
  return {
    snapshot,
    checkSource,
    async materialize(
      destination: string,
      operationSignal: AbortSignal,
      extraFiles: string[] = [],
    ) {
      operationSignal.throwIfAborted();
      await checkSource();
      try {
        await lstat(join(destination, "node_modules"));
        throw new WorkflowFailure("dependency-destination-exists");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      for (const f of files) {
        operationSignal.throwIfAborted();
        const to = join(destination, f.to);
        await mkdir(dirname(to), { recursive: true });
        await copyFile(f.from, to);
        if (hash(await readFile(to)) !== f.hash)
          throw new WorkflowFailure("test-dependencies-changed");
      }
      return async () => {
        const actual: string[] = [];
        async function walk(path: string, prefix: string) {
          operationSignal.throwIfAborted();
          for (const item of await readdir(path, { withFileTypes: true })) {
            const full = join(path, item.name),
              to = join(prefix, item.name);
            const stat = await lstat(full);
            if (
              stat.isSymbolicLink() ||
              (!item.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
            )
              throw new WorkflowFailure("test-dependencies-changed");
            if (item.isDirectory()) await walk(full, to);
            else actual.push(to);
          }
        }
        await walk(join(destination, "node_modules"), "node_modules");
        const expected = new Set(files.map((f) => f.to));
        if (
          actual.filter((p) => !extraFiles.includes(p.replaceAll("\\", "/")))
            .length !== files.length ||
          actual.some(
            (p) =>
              !expected.has(p) && !extraFiles.includes(p.replaceAll("\\", "/")),
          )
        )
          throw new WorkflowFailure("test-dependencies-changed");
        for (const f of files)
          if (hash(await readFile(join(destination, f.to))) !== f.hash)
            throw new WorkflowFailure("test-dependencies-changed");
      };
    },
  };
}
