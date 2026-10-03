import { createHash } from "node:crypto";
import { type Message, type ToolSpec } from "../core/types.js";
import { type ControllerContext, type Runtime } from "./context.js";

export type Premises = { system: string; tools: ToolSpec[] };
export const PREMISE_NOTICE =
  "保存履歴のsystem／toolsの前提が異なるか、旧形式のため照合できません。履歴は保持しています。/clear または新規セッションから続けてください。";
export function premiseHash(premises: Premises): string {
  // Keep order: tool order is part of the preserved prefix. Never persist text.
  return (
    "v1:" + createHash("sha256").update(JSON.stringify(premises)).digest("hex")
  );
}

/** Validate the ACTUAL workflow system/tools before both compaction and streaming. */
export async function checkPremises(
  ctx: ControllerContext,
  id: string,
  rt: Runtime,
  premises: Premises,
  messages: Message[],
): Promise<boolean> {
  const session = ctx.sessions.get(id);
  if (!session) return false;
  const hash = premiseHash(premises);
  if (session.premiseHash !== undefined) {
    if (session.premiseHash !== hash) return false;
  } else {
    // Never retroactively assert that legacy assistant history had this prefix.
    if (messages.some((m) => m.role === "assistant")) return false;
    await ctx.sessions.save({ ...session, premiseHash: hash });
  }
  rt.premises = premises;
  return true;
}
