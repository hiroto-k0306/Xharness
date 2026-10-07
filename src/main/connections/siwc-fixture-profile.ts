import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
/** A reusable marker is created only after the empty-profile verifier succeeds. */
export function siwcFixtureProfile(
  argv: readonly string[],
  fake: boolean,
  packaged: boolean,
  home: string | undefined,
  emptyVerified: boolean,
) {
  if (!argv.includes("--siwc-fixture")) return false;
  if (!fake || packaged || !home || !isAbsolute(home))
    throw new Error("SIWC fixture requires isolated fake profile");
  const marker = join(home, ".siwc-fixture-profile");
  if (emptyVerified)
    writeFileSync(marker, "isolated-siwc-fixture-v1\n", {
      flag: "wx",
      mode: 0o600,
    });
  else if (
    !lstatSync(marker).isFile() ||
    lstatSync(marker).isSymbolicLink() ||
    readFileSync(marker, "utf8") !== "isolated-siwc-fixture-v1\n"
  )
    throw new Error("SIWC fixture profile is not verified");
  return true;
}
