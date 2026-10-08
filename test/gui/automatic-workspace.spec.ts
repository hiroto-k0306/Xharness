import { test, expect } from "./electron.fixture.js";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("ordinary work proposes scope, opens approval and runs in a local child copy", async ({
  gui,
  electronApp,
}) => {
  test.setTimeout(60000);
  const home = await electronApp.evaluate(() => process.env.XHARNESS_HOME!);
  const cwd = join(home, "project");
  await mkdir(cwd);
  await writeFile(join(cwd, "add.mjs"), "export const add=(a,b)=>a-b;\n");
  await writeFile(
    join(cwd, "acceptance.test.mjs"),
    "import assert from 'node:assert/strict';import {add} from './add.mjs';assert.equal(add(2,3),5);\n",
  );
  await electronApp.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
  }, cwd);
  const selected = await gui.evaluate(() =>
    window.harness.command({ type: "pick_folder" }),
  );
  if (!selected.ok || !selected.workspaceId) throw Error("workspace missing");
  const made = await gui.evaluate(
    (workspaceId) =>
      window.harness.command({ type: "new_session", workspaceId }),
    selected.workspaceId,
  );
  if (!made.ok || !made.sessionId) throw Error("session missing");
  const prompt = gui.getByRole("textbox", { name: "prompt", exact: true });
  await prompt.fill("auto-work: 加算を修正してください");
  await prompt.press("Enter");
  const scope = gui.getByRole("region", { name: "実案件の承認範囲" });
  await expect(scope).toContainText("対象フォルダー内に作業用コピーを作成", {
    timeout: 20000,
  });
  await expect(scope).toContainText("add.mjs");
  await expect(scope).toContainText("acceptance.test.mjs");
  const pending = await gui.evaluate(() =>
    window.harness.officialWorkflow!({ action: "list" }),
  );
  const destination =
    pending.records[0]!.record.project!.preparation!.destination;
  expect(destination.startsWith(join(cwd, ".xharness-workspaces"))).toBe(true);
  await expect(access(destination)).rejects.toThrow();
  await gui
    .getByRole("button", { name: "この計画を承認", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await gui.evaluate(() =>
            window.harness.officialWorkflow!({ action: "list" }),
          )
        ).records[0]!.record.status,
      { timeout: 25000 },
    )
    .toBe("completed");
  await expect(prompt).toBeEnabled();
  expect(await readFile(join(cwd, "add.mjs"), "utf8")).toContain("a-b");
  expect(await readFile(join(destination, "add.mjs"), "utf8")).toContain("a+b");
  await expect(access(join(cwd, ".git"))).rejects.toThrow();
  const final = await gui.evaluate(() =>
    window.harness.officialWorkflow!({ action: "list" }),
  );
  expect(
    final.records[0]!.record.checks.at(-1)?.tests.every((t) => t.passed),
  ).toBe(true);
  expect(final.records[0]!.record.reviews.at(-1)?.findings).toEqual([]);
});
