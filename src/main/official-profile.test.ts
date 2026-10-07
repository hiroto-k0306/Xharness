import { expect, it } from "vitest";
import { resolve, join } from "node:path";
import { officialProfile, unavailableLegacy } from "./official-profile.js";
it("isolates official-only before instance locking and requires an absolute home", () => {
  expect(officialProfile([], "relative")).toBeUndefined();
  expect(() => officialProfile(["--official-only"])).toThrow();
  expect(() => officialProfile(["--official-only"], "relative")).toThrow();
  expect(officialProfile(["--official-only"], resolve("isolated"))).toBe(
    join(resolve("isolated"), "electron-user-data"),
  );
});
it("refuses legacy model sends without a credential reader or network", async () => {
  const provider = unavailableLegacy("claude");
  const events = [];
  for await (const event of provider.stream(
    { model: "opus", system: "", messages: [], tools: [] },
    new AbortController().signal,
  ))
    events.push(event);
  expect(events).toMatchObject([
    { type: "error", error: { retryable: false } },
  ]);
});
