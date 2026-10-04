import { describe, expect, it } from "vitest";
import { resolve, join } from "node:path";
import { fakeUserDataPath } from "./fake-profile.js";

describe("fakeUserDataPath", () => {
  const home = resolve("isolated-gui-home");
  it("isolates the explicitly selected development fake profile", () => {
    expect(fakeUserDataPath(true, false, home)).toBe(
      join(home, "electron-user-data"),
    );
  });
  it.each<[boolean, boolean, string | undefined]>([
    [false, false, home],
    [false, true, home],
    [true, true, home],
    [true, false, undefined],
    [true, false, ""],
    [false, false, "relative"],
  ])(
    "leaves regular profiles unchanged (%s, %s, %s)",
    (fake, packaged, base) => {
      expect(fakeUserDataPath(fake, packaged, base)).toBeUndefined();
    },
  );
  it("rejects a relative fake home without echoing its value", () => {
    expect(() =>
      fakeUserDataPath(true, false, "private-relative-path"),
    ).toThrow("開発版 --fake の XHARNESS_HOME は絶対パスで指定してください");
  });
});
