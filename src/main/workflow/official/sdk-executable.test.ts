import { expect, it } from "vitest";
import { sdkExecutable } from "./sdk-executable.js";
it("maps the packaged SDK native binary to its existing unpacked file only", () => {
  const virtual = "C:\\app\\resources\\app.asar\\node_modules\\sdk\\claude.exe";
  const physical = virtual.replace("app.asar", "app.asar.unpacked");
  expect(sdkExecutable(virtual, (path) => path === physical)).toBe(physical);
  expect(() => sdkExecutable(virtual, () => false)).toThrow(
    "sdk-unpacked-executable-missing",
  );
  expect(sdkExecutable("C:\\dev\\claude.exe", () => false)).toBe(
    "C:\\dev\\claude.exe",
  );
  expect(sdkExecutable(physical, () => false)).toBe(physical);
});
