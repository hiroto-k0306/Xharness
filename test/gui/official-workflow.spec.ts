import { test, expect } from "./electron.fixture.js";
test("official single-task UI approves, cancels, restores checkpoints and cross-reviews both providers", async ({
  gui,
}) => {
  await gui.getByRole("button", { name: /new session/ }).click();
  await gui.getByRole("button", { name: "公式workflow", exact: true }).click();
  const panel = gui.getByRole("region", { name: "公式単一タスクworkflow" });
  await expect(panel.getByText(/FAKE：モデルは模擬/)).toBeVisible();
  await panel.getByRole("button", { name: "合成課題の計画を作成" }).click();
  await expect(
    panel.getByRole("button", { name: "この計画を承認" }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "workflowを中断" }).click();
  await expect(panel.getByRole("heading", { name: /cancelled/ })).toBeVisible();
  await gui.reload();
  await gui.getByRole("button", { name: "公式workflow", exact: true }).click();
  await panel.getByRole("button", { name: "安全な段階から再開" }).click();
  await panel.getByRole("button", { name: "この計画を承認" }).click();
  await expect(panel.getByRole("heading", { name: /completed/ })).toBeVisible({
    timeout: 15000,
  });
  await expect(panel.getByText(/arithmetic 不合格/)).toBeVisible();
  await expect(panel.getByText(/arithmetic 合格/)).toBeVisible();
  await expect(panel.getByText(/全差分レビュー 2：指摘なし/)).toBeVisible();
  await panel
    .getByRole("combobox", { name: "公式workflow実装候補" })
    .selectOption("codex");
  await panel.getByRole("button", { name: "合成課題の計画を作成" }).click();
  await panel.getByRole("button", { name: "この計画を承認" }).click();
  await expect(panel.getByRole("heading", { name: /completed/ })).toHaveCount(
    2,
    { timeout: 15000 },
  );
  await gui.screenshot({ path: ".out/official-workflow-ui.png" });
});
