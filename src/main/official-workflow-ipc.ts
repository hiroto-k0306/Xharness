import { ipcMain, type BrowserWindow } from "electron";
import { z } from "zod";
import { OFFICIAL_WORKFLOW_CHANNEL } from "../shared/official-workflow.js";
import type { OfficialWorkflowService } from "./workflow/official/service.js";
const id = z.string().uuid();
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("configure_auto") }).strict(),
  z
    .object({
      action: z.literal("chat"),
      provider: z.enum(["claude", "codex"]),
      text: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      action: z.literal("configure"),
      codexPath: z.string().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      action: z.literal("workspace_root"),
      path: z.string().max(1000),
    })
    .strict(),
  z
    .object({
      action: z.literal("create"),
      provider: z.enum(["claude", "codex"]),
      mode: z.enum(["single", "dag"]).optional(),
      task: z.literal("typed-add-v1").optional(),
      planner: z
        .object({
          model: z.string().min(1).max(200),
          effort: z
            .enum(["low", "medium", "high", "xhigh", "max"])
            .nullable()
            .optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("approve"),
      id,
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z.object({ action: z.enum(["cancel", "resume"]), id }).strict(),
  z
    .object({
      action: z.literal("tool_decision"),
      id,
      approvalId: id,
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      allow: z.boolean(),
    })
    .strict(),
]);
export function registerOfficialWorkflowIpc(
  getWindow: () => BrowserWindow | null,
  service: OfficialWorkflowService,
) {
  ipcMain.handle(OFFICIAL_WORKFLOW_CHANNEL, async (event, raw: unknown) => {
    const window = getWindow();
    if (
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("Workflow origin rejected");
    const parsed = command.safeParse(raw);
    if (!parsed.success) throw new Error("Invalid workflow command");
    return service.command(parsed.data);
  });
}
