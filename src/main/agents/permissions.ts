import { relative, matchesGlob } from "node:path";
import { FileAccess } from "../tools/files.js";
import { type ChildContext } from "./runner.js";
import { type ToolCall } from "../tools/registry.js";
/** Bash is always confirmed for workers; declared globs cover canonical file writes. */
export async function childNeedsAsk(
  call: ToolCall,
  context: ChildContext,
): Promise<boolean> {
  if (!context.files) return false;
  if (call.name === "Bash") return true;
  if (!["Write", "Edit"].includes(call.name)) return false;
  const access = new FileAccess(context.cwd);
  const path = await access.path(
    String((call.input as { path?: unknown }).path),
  );
  const normalize = (s: string) =>
    s.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  const target = normalize(relative(await access.path("."), path));
  return !context.files.some((pattern) =>
    matchesGlob(target, normalize(pattern)),
  );
}
