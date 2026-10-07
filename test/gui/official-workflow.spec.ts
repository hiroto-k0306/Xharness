import { test, expect } from "./electron.fixture.js";

test("official questions end once without entering a planning loop and survive reload", async ({
  gui,
}) => {
  await gui.getByRole("button", { name: "公式workflow", exact: true }).click();
  for (const [i, question] of [
    "こんにちは",
    "もう少し説明して",
    "作業ありがとう",
  ].entries()) {
    await gui.getByRole("textbox", { name: "公式接続への質問" }).fill(question);
    await gui.getByRole("button", { name: "質問だけ送信" }).click();
    await expect(gui.getByLabel("公式回答")).toHaveCount(i + 1);
  }
  await expect(gui.getByRole("button", { name: "この計画を承認" })).toHaveCount(
    0,
  );
  await gui.reload();
  await gui.getByRole("button", { name: "公式workflow", exact: true }).click();
  await expect(gui.getByLabel("公式回答")).toHaveCount(3);
});
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
test("synthetic DAG UI restores approval and displays serial imports and full integration evidence", async ({
  gui,
}) => {
  test.setTimeout(60000);
  await gui.getByRole("button", { name: /new session/ }).click();
  await gui.getByRole("button", { name: "公式workflow", exact: true }).click();
  const panel = gui.getByRole("region", { name: "公式単一タスクworkflow" });
  await panel
    .getByRole("combobox", { name: "workflow実行方式" })
    .selectOption("dag");
  await expect(panel.getByText(/DAGは固定合成課題の模擬実行/)).toBeVisible();
  await panel.getByRole("button", { name: "合成課題の計画を作成" }).click();
  await expect(
    panel.getByRole("button", { name: "この計画を承認" }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "workflowを中断" }).click();
  await gui.reload();
  await gui.getByRole("button", { name: "公式workflow", exact: true }).click();
  await panel.getByRole("button", { name: "安全な段階から再開" }).click();
  await panel.getByRole("button", { name: "この計画を承認" }).click();
  await expect(panel.getByRole("heading", { name: /completed/ })).toBeVisible({
    timeout: 45000,
  });
  for (const id of ["add", "multiply", "combine"])
    await expect(
      panel.getByText(new RegExp(`^${id}: integrated`)),
    ).toBeVisible();
  await expect(panel.getByText(/native会話resume未対応/)).toBeVisible();
  await gui.screenshot({ path: ".out/official-workflow-dag-ui.png" });
});
