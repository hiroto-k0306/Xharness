import { mkdtemp, mkdir, rename, rm, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tsImport } from "tsx/esm/api";

// electron-builder omits some peers and type declarations from app.asar.
// Ship the validated dependency closure as ordinary resources for runtime seeding.
export default async function prepareSdkRuntime(context) {
  const { bundledSdkDirectory, seedSdk, validateSdkTree, packageJson } =
    await tsImport(
      "../src/main/workflow/official/sdk-install.ts",
      import.meta.url,
    );
  const root = resolve(context.packager.info.appDir, ".out");
  await mkdir(root, { recursive: true });
  const stage = await mkdtemp(join(root, "sdk-seed-stage-"));
  const target = join(root, "claude-sdk-seed");
  const source = await bundledSdkDirectory();
  const { version } = await packageJson(source);
  await seedSdk(stage, source);
  await validateSdkTree(stage, version);
  const old = await lstat(target).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (old?.isSymbolicLink() || (old && !old.isDirectory()))
    throw new Error("SDK seed output is not an ordinary directory");
  // Both paths are fixed children of this build's resolved .out directory.
  if (old) await rm(target, { recursive: true });
  await rename(stage, target);
}
