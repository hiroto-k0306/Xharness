import { resolve } from "node:path";
import { normalizeFile, relativeFile, type AgentRequest } from "./contracts.js";
/** Direct native file edits are restricted to exact approved DAG files. */
export function approvedWriteScope(
  request: Pick<AgentRequest, "cwd" | "nativeWork" | "writeScope">,
): Set<string> | undefined {
  if (request.writeScope === undefined) return undefined;
  if (
    !request.nativeWork ||
    !Array.isArray(request.writeScope) ||
    request.writeScope.length < 1 ||
    request.writeScope.length > 30
  )
    throw new Error("invalid-write-scope");
  const paths = request.writeScope.map((file) => {
    if (!relativeFile.safeParse(file).success)
      throw new Error("invalid-write-scope");
    return normalizeFile(resolve(request.cwd, file));
  });
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length)
    throw new Error("invalid-write-scope");
  return new Set(paths);
}
export function withinWriteScope(
  scope: Set<string> | undefined,
  cwd: string,
  file: string,
): boolean {
  return scope === undefined || scope.has(normalizeFile(resolve(cwd, file)));
}
