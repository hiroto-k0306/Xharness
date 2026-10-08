import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  lstat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import {
  SDK_NAME,
  nativePackage,
  compatibleSdk,
  type SdkPackage,
} from "./sdk-package.js";

export async function packageJson(directory: string): Promise<SdkPackage> {
  return JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  ) as SdkPackage;
}
export async function bundledSdkDirectory() {
  return dirname(createRequire(import.meta.url).resolve(SDK_NAME));
}
async function findPackage(name: string, from: string) {
  const require = createRequire(join(from, "package.json"));
  // Some packages export only subpaths and map package.json to a dist stub.
  for (const modules of require.resolve.paths(name) ?? []) {
    const directory = join(modules, name);
    try {
      if ((await packageJson(directory)).name === name)
        return await realpath(directory);
    } catch {
      /* try the next Node resolution directory */
    }
  }
  try {
    const directory = dirname(require.resolve(`${name}/package.json`));
    if ((await packageJson(directory)).name === name) return directory;
  } catch {
    /* exports may hide metadata */
  }
  let directory = dirname(require.resolve(name));
  for (let i = 0; i < 15; i++) {
    try {
      if ((await packageJson(directory)).name === name) return directory;
    } catch {
      /* keep walking */
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("sdk-dependency-unavailable");
}
/** Materialize the app's trusted dependency closure; no package-manager/install scripts. */
export async function seedSdk(destination: string, source: string) {
  type Scope = {
    modules: string;
    versions: Map<string, { version: string; source: string }>;
  };
  const root: Scope = {
    modules: join(destination, "node_modules"),
    versions: new Map(),
  };
  let count = 0;
  async function copy(directory: string, scopes: Scope[]) {
    const source = await realpath(directory);
    const pkg = await packageJson(directory);
    if (
      typeof pkg.name !== "string" ||
      !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(pkg.name) ||
      pkg.name
        .split("/")
        .some(
          (part) =>
            part === "." ||
            part === ".." ||
            /[. ]$/.test(part) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        )
    )
      throw new Error("sdk-package-name-invalid");
    const nearest = scopes.find((s) => s.versions.has(pkg.name));
    const found = nearest?.versions.get(pkg.name);
    if (found?.version === pkg.version && found.source === source) return;
    if (++count > 256 || scopes.length > 30)
      throw new Error("sdk-dependency-graph-too-large");
    // Hoist unique dependencies; preserve conflicting versions beneath their owner.
    const scope = root.versions.has(pkg.name) ? scopes[0]! : root;
    if (scope.versions.has(pkg.name))
      throw new Error("sdk-dependency-version-conflict");
    scope.versions.set(pkg.name, { version: pkg.version, source });
    const target = join(scope.modules, pkg.name);
    await mkdir(target, { recursive: true });
    for (const name of await readdir(directory)) {
      if (name === "node_modules") continue;
      // Electron transparently reads app.asar; native executables live unpacked.
      const file = join(directory, name);
      const physical = file.replace(/([\\/]app\.asar)([\\/])/, "$1.unpacked$2");
      const readFrom =
        physical !== file &&
        (await lstat(physical).then(
          () => true,
          () => false,
        ))
          ? physical
          : file;
      await cp(readFrom, join(target, name), {
        recursive: true,
        dereference: true,
        errorOnExist: true,
        force: false,
      });
    }
    const dependencies = {
      ...pkg.dependencies,
      ...pkg.peerDependencies,
      ...(pkg.name === SDK_NAME ? {} : pkg.optionalDependencies),
    };
    if (pkg.name === SDK_NAME)
      dependencies[nativePackage()] =
        pkg.optionalDependencies?.[nativePackage()] ?? "";
    const localScope: Scope = {
      modules: join(target, "node_modules"),
      versions: new Map(),
    };
    for (const name of Object.keys(dependencies)) {
      let child: string;
      try {
        child = await findPackage(name, directory);
      } catch (error) {
        if (
          pkg.peerDependenciesMeta?.[name]?.optional ||
          (pkg.name !== SDK_NAME && pkg.optionalDependencies?.[name])
        )
          continue;
        throw error;
      }
      if (pkg.optionalDependencies?.[name] && name !== nativePackage()) {
        const optional = await packageJson(child);
        const accepts = (values: string[] | undefined, current: string) =>
          !values ||
          (!values.includes(`!${current}`) &&
            (!values.some((v) => !v.startsWith("!")) ||
              values.includes(current)));
        if (
          !accepts(optional.os, process.platform) ||
          !accepts(optional.cpu, process.arch)
        )
          continue;
      }
      // Reuse the same scope for all children (including duplicate peers/cycles).
      await copy(child, [localScope, ...scopes.slice(scopes.indexOf(scope))]);
    }
  }
  await copy(source, [root]);
}
export async function validateSdkTree(directory: string, version: string) {
  const sdk = join(directory, "node_modules", SDK_NAME);
  const native = join(directory, "node_modules", nativePackage());
  for (const file of [
    directory,
    sdk,
    native,
    join(sdk, "sdk.mjs"),
    join(native, process.platform === "win32" ? "claude.exe" : "claude"),
  ]) {
    if (
      (await lstat(file)).isSymbolicLink() ||
      (await realpath(file)).toLowerCase() !== resolve(file).toLowerCase()
    )
      throw new Error("sdk-installation-linked");
  }
  const sdkMetadata = await packageJson(sdk),
    nativeMetadata = await packageJson(native);
  if (
    sdkMetadata.name !== SDK_NAME ||
    sdkMetadata.version !== version ||
    nativeMetadata.name !== nativePackage() ||
    nativeMetadata.version !== version ||
    !compatibleSdk(sdkMetadata, await packageJson(await bundledSdkDirectory()))
  )
    throw new Error("sdk-installation-version-mismatch");
  const types = await readFile(join(sdk, "sdk.d.ts"), "utf8");
  for (const name of [
    "accountInfo",
    "supportedModels",
    "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET",
    "canUseTool",
    "spawnClaudeCodeProcess",
  ])
    if (!types.includes(name)) throw new Error("sdk-contract-unsupported");
  return join(sdk, "sdk.mjs");
}
