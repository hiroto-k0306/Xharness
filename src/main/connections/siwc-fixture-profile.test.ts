import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { siwcFixtureProfile } from "./siwc-fixture-profile.js";
it("requires explicit fake isolated profile and restores only a verified marker", () => {
  const home = mkdtempSync(join(tmpdir(), "xh-siwc-profile-"));
  try {
    expect(siwcFixtureProfile([], false, false, home, false)).toBe(false);
    expect(() =>
      siwcFixtureProfile(["--siwc-fixture"], true, false, home, false),
    ).toThrow();
    expect(() =>
      siwcFixtureProfile(["--siwc-fixture"], false, false, home, true),
    ).toThrow();
    expect(() =>
      siwcFixtureProfile(["--siwc-fixture"], true, true, home, true),
    ).toThrow();
    expect(() =>
      siwcFixtureProfile(["--siwc-fixture"], true, false, "relative", true),
    ).toThrow();
    expect(
      siwcFixtureProfile(["--siwc-fixture"], true, false, home, true),
    ).toBe(true);
    expect(
      siwcFixtureProfile(["--siwc-fixture"], true, false, home, false),
    ).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
