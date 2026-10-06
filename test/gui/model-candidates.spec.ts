import { test, expect } from "./electron.fixture.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("fake candidate reasons require explicit selection and preserve defaults after reload", async ({
  gui,
  electronApp,
}, info) => {
  const root = await mkdtemp(join(tmpdir(), "xh-candidates-gui-"));
  try {
    const home = await electronApp.evaluate(() => process.env.XHARNESS_HOME!);
    await writeFile(join(home, "config.yaml"), "workflow: {mode: off}\n");
    await mkdir(join(root, ".agents"));
    await electronApp.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, root);
    const picked = await gui.evaluate(() =>
      window.harness.command({ type: "pick_folder" }),
    );
    if (!picked.ok || !picked.workspaceId) throw new Error("workspace");
    const made = await gui.evaluate(
      (workspaceId) =>
        window.harness.command({ type: "new_session", workspaceId }),
      picked.workspaceId,
    );
    if (!made.ok || !made.sessionId) throw new Error("session");
    const sessionId = made.sessionId;
    const created = await gui.evaluate(
      (sessionId) =>
        window.harness.command({
          type: "improvements",
          sessionId,
          operationId: "gui-create",
          request: {
            action: "create",
            name: "モデル候補fixture",
            body: "Reply concisely",
            source: {},
            cases: [
              {
                id: "ping",
                prompt: "Reply pong",
                taskType: "text",
                difficulty: "small",
                criteria: "human output check v1",
                environment: "isolated fake",
              },
            ],
          },
        }),
      sessionId,
    );
    if (!created.ok || !created.improvements) throw new Error("comparison");
    let entry = created.improvements.entries[0]!;
    const prepared = await gui.evaluate(
      ({ sessionId, entry }) =>
        window.harness.command({
          type: "improvements",
          sessionId,
          operationId: "gui-prepare",
          request: {
            action: "prepare",
            id: entry.id,
            revision: entry.revision,
            versionId: entry.versions[0]!.id,
            caseId: "ping",
          },
        }),
      { sessionId, entry },
    );
    if (!prepared.ok || !prepared.preparedPrompt) throw new Error("prepare");
    await gui.evaluate(
      ({ sessionId, text }) =>
        window.harness.command({ type: "send", sessionId, text }),
      { sessionId, text: prepared.preparedPrompt },
    );
    await expect(
      gui.getByRole("textbox", { name: "prompt", exact: true }),
    ).toBeEnabled();
    const recorded = await gui.evaluate(
      ({ sessionId, entry }) =>
        window.harness.command({
          type: "improvements",
          sessionId,
          operationId: "gui-record",
          request: {
            action: "record",
            id: entry.id,
            revision: entry.revision,
            versionId: entry.versions[0]!.id,
            caseId: "ping",
            sessionId: "current",
            taskId: "current",
            passed: true,
            evidence: "Human checked fixture output; mock is not production",
          },
        }),
      { sessionId, entry },
    );
    if (!recorded.ok || !recorded.improvements)
      throw new Error(JSON.stringify(recorded));
    entry = recorded.improvements.entries[0]!;
    await gui
      .getByRole("button", { name: "改善版の比較", exact: true })
      .click();
    const panel = gui.getByRole("dialog", { name: "改善版の比較" });
    await panel
      .getByRole("combobox", { name: "比較を選択" })
      .selectOption({ label: entry.name });
    const section = panel.getByRole("region", { name: "根拠付きモデル候補" });
    await section
      .getByRole("button", { name: "モデル候補を確認（通信なし）" })
      .click();
    await expect(section.getByText("優先検討:", { exact: false })).toHaveCount(
      0,
    );
    await expect(
      section.getByText(
        "Human checked fixture output; mock is not production",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(section.getByText("mock", { exact: false })).not.toHaveCount(
      0,
    );
    const apply = section.getByRole("button", {
      name: "候補をこのセッションに適用（通信なし）",
    });
    await expect(apply).toBeDisabled();
    const observation = await gui.evaluate(
      ({ sessionId, entry }) =>
        window.harness.command({
          type: "improvements",
          sessionId,
          operationId: "gui-query",
          request: {
            action: "model_candidates",
            id: entry.id,
            revision: entry.revision,
            versionId: entry.versions[0]!.id,
            caseId: "ping",
          },
        }),
      { sessionId, entry },
    );
    if (!observation.ok || !observation.modelCandidates)
      throw new Error("candidates");
    // Use a different effort or model from the fixed fake task; confirmation
    // remains an explicit reference decision with no automatic model call.
    const target = observation.modelCandidates.candidates.find(
      (c) => c.selectable && !c.samples.length && c.model !== "fake",
    )!;
    await section
      .getByRole("button", { name: "モデル候補を確認（通信なし）" })
      .click();
    await section
      .getByRole("combobox", { name: "明示選択するモデル" })
      .selectOption(target.id);
    await section
      .getByRole("textbox", { name: "モデル選択理由" })
      .fill("模擬の限界を確認した明示選択");
    await expect(apply).toBeDisabled();
    await section
      .getByRole("checkbox", { name: "モデルと根拠不足を確認して明示選択" })
      .check();
    await apply.click();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(
      section.getByRole("checkbox", {
        name: "モデルと根拠不足を確認して明示選択",
      }),
    ).not.toBeChecked();
    await gui.screenshot({
      path: info.outputPath("model-candidates.png"),
      fullPage: true,
    });
    await gui.reload();
    await expect(gui.getByText("FAKE", { exact: true })).toBeVisible();
    const state = await gui.evaluate(
      () =>
        new Promise<import("../../src/shared/ipc.js").AppState>((resolve) => {
          const unsubscribe = window.harness.onEvent((event) => {
            if (event.type === "state") {
              unsubscribe();
              resolve(event.state);
            }
          });
          void window.harness.command({ type: "ready" });
        }),
    );
    expect(state.sessions.find((s) => s.id === sessionId)?.model).toBe(
      target.model,
    );
    expect(state.model).not.toBe(target.model);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
