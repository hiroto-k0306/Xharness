import { test, expect } from "./electron.fixture.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("explicit fake skill listing and selection load preserve permissions and appear in evaluation report", async ({
  gui,
  electronApp,
}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), "xh-skills-gui-"));
  try {
    const home = await electronApp.evaluate(() => process.env.XHARNESS_HOME!);
    await writeFile(join(home, "config.yaml"), "workflow: {mode: off}\n");
    const source = ".agents/skills/offline/SKILL.md";
    const text =
      "---\nname: offline\ndescription: Local fake recipe\n---\nNative skill offline body. Use current permissions.\n";
    const hash = createHash("sha256").update(text).digest("hex");
    await mkdir(join(root, ".agents/skills/offline"), { recursive: true });
    await writeFile(join(root, source), text);
    await writeFile(
      join(root, ".agents/skills/offline/install.ps1"),
      "throw 'must never run'",
    );
    await electronApp.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, root);
    const picked = await gui.evaluate(() =>
      window.harness.command({ type: "pick_folder" }),
    );
    if (!picked.ok || !picked.workspaceId) throw new Error("Missing workspace");
    const created = await gui.evaluate(
      (workspaceId) =>
        window.harness.command({ type: "new_session", workspaceId }),
      picked.workspaceId,
    );
    if (!created.ok || !created.sessionId) throw new Error("Missing task");
    await gui.evaluate(
      (sessionId) =>
        window.harness.command({
          type: "set_mode",
          sessionId,
          mode: "default",
        }),
      created.sessionId,
    );
    const prompt = gui.getByRole("textbox", { name: "prompt", exact: true });
    await prompt.fill("skills-demo: list");
    await prompt.press("Enter");
    const listing = gui.getByRole("alertdialog", {
      name: "ListProjectSkills の実行確認",
    });
    await expect(listing).toContainText("上位指示・権限は変わりません");
    await listing.getByRole("button", { name: /allow/ }).click();
    const result = gui.getByText(/Skill reference data:/);
    await expect(result).toContainText(source);
    await expect(result).toContainText(hash);
    await expect(result).not.toContainText("Native skill offline body");
    await expect(prompt).toBeEnabled();
    await prompt.fill(`skills-demo: load ${source} ${hash}`);
    await prompt.press("Enter");
    const load = gui.getByRole("alertdialog", {
      name: "LoadProjectSkill の実行確認",
    });
    await expect(load).toContainText(
      "付属script・install手順は自動実行しません",
    );
    await load.getByRole("button", { name: /allow/ }).click();
    await expect(result.last()).toContainText("Native skill offline body");
    await expect(result.last()).toContainText("untrusted");
    await expect(prompt).toBeEnabled();
    const output = testInfo.outputPath("skills.html");
    await electronApp.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, output);
    expect(
      (
        await gui.evaluate(
          (sessionId) =>
            window.harness.command({ type: "export_report", sessionId }),
          created.sessionId,
        )
      ).ok,
    ).toBe(true);
    const html = await readFile(output, "utf8");
    expect(html).toContain("スキルの参照記録");
    expect(html).toContain(hash);
    expect(html).toContain("returnedCharacters");
    await gui.screenshot({ path: testInfo.outputPath("skills.png") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
