import { afterEach, expect, it } from "vitest";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectProjectInventory,
  assertInventoryUnchanged,
} from "./project-inventory.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "xh-auto-inventory-"));
  roots.push(root);
  await writeFile(join(root, "add.mjs"), "export const add=(a,b)=>a-b;\n");
  await writeFile(join(root, "acceptance.test.mjs"), "import './add.mjs';\n");
  return root;
}
it("discovers existing tests and safe source data without executing or writing", async () => {
  const root = await fixture();
  await writeFile(join(root, ".env"), "KEEP_SECRET");
  await writeFile(join(root, "binary.bin"), Buffer.from([1, 0, 2]));
  await mkdir(join(root, "node_modules"));
  await writeFile(
    join(root, "node_modules/hidden.test.mjs"),
    "throw Error('must not run');",
  );
  const before = await readFile(join(root, "add.mjs"));
  const inventory = await inspectProjectInventory(
    root,
    new AbortController().signal,
  );
  expect(inventory.tests).toEqual(["acceptance.test.mjs"]);
  expect(inventory.files.map((f) => f.path)).toEqual([
    "acceptance.test.mjs",
    "add.mjs",
  ]);
  expect(JSON.stringify(inventory)).not.toContain("KEEP_SECRET");
  expect(await readFile(join(root, "add.mjs"))).toEqual(before);
  await assertInventoryUnchanged(inventory, new AbortController().signal);
  await writeFile(join(root, "add.mjs"), "changed");
  await expect(
    assertInventoryUnchanged(inventory, new AbortController().signal),
  ).rejects.toThrow("project-changed-after-inspection");
});
it("omits hardlinks and linked directories instead of traversing them", async () => {
  const root = await fixture(),
    outside = await fixture();
  await link(join(outside, "add.mjs"), join(root, "hard.mjs"));
  await symlink(
    outside,
    join(root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const inventory = await inspectProjectInventory(
    root,
    new AbortController().signal,
  );
  expect(inventory.files.map((f) => f.path)).not.toContain("hard.mjs");
  expect(inventory.files.some((f) => f.path.startsWith("linked/"))).toBe(false);
});
it("rejects native configuration and cancellation", async () => {
  const root = await fixture();
  await mkdir(join(root, ".claude"));
  await expect(
    inspectProjectInventory(root, new AbortController().signal),
  ).rejects.toThrow("project-native-or-harness-configuration");
  const other = await fixture();
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    inspectProjectInventory(other, cancelled.signal),
  ).rejects.toThrow();
});
