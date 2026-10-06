import { ipcMain, type BrowserWindow } from "electron";
import { z } from "zod";
import { OFFICIAL_WORKFLOW_CHANNEL } from "../shared/official-workflow.js";
import type { OfficialWorkflowService } from "./workflow/official/service.js";
const id = z.string().uuid();
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({
      action: z.literal("create"),
      provider: z.enum(["claude", "codex"]),
      mode: z.enum(["single", "dag"]).optional(),
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
