/** Manual, explicitly authorized only. Never part of test/build/package scripts. */
import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionStore } from "../src/main/session/store.js";
import { readTraceReplay } from "../src/main/session/report-trace.js";
import { evaluateTrace } from "../src/main/session/evaluation.js";

if (!process.argv.includes("--authorized-live"))
  throw new Error("Explicit live authorization required");
// Presence only: never print credential values or inspect credential files.
if (
  [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CONFIG_DIR",
  ].some((k) => process.env[k])
)
  throw new Error("Non-default SDK route present; stop for review");
const home = await mkdtemp(join(tmpdir(), "xh-connection-live-"));
const root = resolve(".");
const output =
  process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ??
  `.out/connections-ui-live-${Date.now()}.json`;
const exists = await access(output).then(
  () => true,
  () => false,
);
if (exists)
  throw new Error("Live evidence output already exists; use a fresh path");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k, v]) =>
      v !== undefined &&
      ![
        "ELECTRON_RUN_AS_NODE",
        "ELECTRON_RENDERER_URL",
        "NODE_OPTIONS",
      ].includes(k),
  ),
) as Record<string, string>;
const application = await electron.launch({
  cwd: root,
  args: [
    root,
    ...(process.argv.includes("--offline") ? ["--fake"] : []),
    "--connection-test",
  ],
  env: { ...env, XHARNESS_HOME: home },
  timeout: 15000,
});
const results: unknown[] = [];
try {
  expect(
    await application.evaluate(({ app }) => ({
      userData: app.getPath("userData"),
      sessionData: app.getPath("sessionData"),
      packaged: app.isPackaged,
    })),
  ).toEqual({
    userData: join(home, "electron-user-data"),
    sessionData: join(home, "electron-user-data"),
    packaged: false,
  });
  const page = await application.firstWindow();
  for (const mode of process.argv.includes("--launch-only")
    ? []
    : (["claude-mcp", "claude-proposals"] as const)) {
    let id: string | undefined;
    let approved = false;
    let success = false;
    try {
      const created = await page.evaluate(() =>
        window.harness.command({ type: "new_session", workspaceId: null }),
      );
      if (!created.ok || !created.sessionId) throw new Error("session");
      id = created.sessionId;
      await page.getByRole("button", { name: /^接続方式:/ }).click();
      await page.getByRole("combobox", { name: "接続方式" }).selectOption(mode);
      if (mode === "claude-mcp") {
        await page.getByRole("button", { name: "公式SDK接続を確認" }).click();
        await expect(page.getByRole("status")).toContainText("利用可能", {
          timeout: 65000,
        });
      }
      await page.getByRole("button", { name: "接続を適用" }).click();
      const prompt = page.getByRole("textbox", { name: "prompt", exact: true });
      await prompt.fill(
        "Call the only X-owned EvalEcho tool exactly once with value=seed (MCP args: id=eval_once,input={value:seed}; action proposal: id=eval_once,tool=EvalEcho,input={value:seed}). After the actual tool result is returned, reply with exactly its result, EVAL-OK-42. Do not guess the result or call any other tool. For action proposals after the result use actions=[].",
      );
      await prompt.press("Enter");
      const approval = page.getByRole("alertdialog", {
        name: "EvalEcho の実行確認",
      });
      await expect(approval).toBeVisible({ timeout: 65000 });
      await approval.getByRole("button", { name: /allow/ }).click();
      approved = true;
      await expect(prompt).toBeEnabled({ timeout: 125000 });
      await expect(
        page.getByText("EVAL-OK-42", { exact: true }).last(),
      ).toBeVisible({ timeout: 5000 });
      success = true;
    } catch {
      // No retry, fallback, or raw provider error logging.
    }
    const trace = id ? await readTraceReplay(home, id, (x) => x) : undefined;
    const history = id ? await new SessionStore(home).messages(id) : [];
    const task = evaluateTrace(trace)[0];
    const toolSpans =
      trace?.records.filter(
        (r) => r.kind === "tool" && r.label === "EvalEcho" && r.phase === "end",
      ) ?? [];
    const savedResult = history.some((m) =>
      m.content.some(
        (b) => b.type === "tool_result" && b.content === "EVAL-OK-42",
      ),
    );
    const savedAnswer = history
      .at(-1)
      ?.content.some(
        (b) => b.type === "text" && b.text.trim() === "EVAL-OK-42",
      );
    success &&=
      approved && toolSpans.length === 1 && savedResult && !!savedAnswer;
    results.push({
      mode,
      sessionId: id,
      approved,
      success,
      toolExecutions: toolSpans.length,
      savedResult,
      savedAnswer,
      task,
      requestedModels: [
        ...new Set(
          history.flatMap((m) => (m.meta?.model ? [m.meta.model] : [])),
        ),
      ],
      queryHttpCount: "SDK internal HTTP count unknown",
    });
    if (!success) break;
  }
} finally {
  await application.close();
  await mkdir(".out", { recursive: true });
  await writeFile(
    output,
    JSON.stringify({ home, at: new Date().toISOString(), results }, null, 2),
    { flag: "wx" },
  );
}
console.log(
  JSON.stringify({
    tasks: results.length,
    passed: results.filter((r) => (r as { success: boolean }).success).length,
    evidence: output,
  }),
);
