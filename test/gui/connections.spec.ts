import { test, expect } from "./electron.fixture.js";
test("explicit connection selection, cancellation, unconfigured refusal and fake SDK send", async ({
  gui,
}) => {
  await gui.getByRole("button", { name: /new session/ }).click();
  const open = gui.getByRole("button", { name: /^接続方式:/ });
  await open.click();
  await gui
    .getByRole("combobox", { name: "接続方式" })
    .selectOption("openai-siwc");
  await expect(gui.getByRole("status")).toContainText(
    "専用の発行済みclient ID",
  );
  await gui.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(open).toHaveText("接続方式: 既存方式");
  await open.click();
  await gui
    .getByRole("combobox", { name: "接続方式" })
    .selectOption("openai-siwc");
  await gui.getByRole("button", { name: "接続を適用" }).click();
  const prompt = gui.getByRole("textbox", { name: "prompt", exact: true });
  await prompt.fill("Do not dispatch");
  await prompt.press("Enter");
  await expect(prompt).toHaveValue("Do not dispatch");
  await expect(
    gui.getByText(/専用の発行済みclient ID/, { exact: false }),
  ).toBeVisible();
  await open.click();
  await gui
    .getByRole("combobox", { name: "接続方式" })
    .selectOption("claude-mcp");
  await gui.getByRole("button", { name: "接続を適用" }).click();
  await prompt.fill("Fixture");
  await prompt.press("Enter");
  await expect(gui.getByText("OK", { exact: true })).toBeVisible();
  await expect(prompt).toHaveValue("");
});
