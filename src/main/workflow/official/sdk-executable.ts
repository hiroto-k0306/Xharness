import { existsSync } from "node:fs";
import { WorkflowFailure } from "./contracts.js";

/** Win32 CreateProcess cannot use Electron's virtual asar filesystem. */
export function sdkExecutable(program: string, exists = existsSync) {
  const physical = program.replace(/([\\/]app\.asar)([\\/])/, "$1.unpacked$2");
  if (physical === program) return program;
  if (!exists(physical))
    throw new WorkflowFailure("sdk-unpacked-executable-missing");
  return physical;
}
