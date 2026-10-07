import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { connectionTestProfile, connectionTestTools } from "./test-profile.js";
it("requires explicit unpackaged empty absolute home before profile access", async () => {
  expect(connectionTestProfile([], false)).toBeUndefined();
  for (const home of [undefined, "relative"])
    expect(() =>
      connectionTestProfile(["--connection-test"], false, home),
    ).toThrow();
  const home = await mkdtemp(join(tmpdir(), "xh-live-fixture-"));
  expect(() =>
    connectionTestProfile(["--connection-test"], true, home),
  ).toThrow();
  expect(connectionTestProfile(["--connection-test"], false, home)).toBe(
    join(home, "electron-user-data"),
  );
  await writeFile(join(home, "marker"), "existing");
  expect(() =>
    connectionTestProfile(["--connection-test"], false, home),
  ).toThrow();
});
it("exposes only a strict harmless once-per-session tool", async () => {
  const tools = connectionTestTools();
  expect([...tools.keys()]).toEqual(["EvalEcho"]);
  const tool = tools.get("EvalEcho")!;
  expect(await tool.validate({ value: "seed" })).toBeUndefined();
  expect(
    await tool.validate({ value: "seed", path: "user-file" }),
  ).toBeDefined();
  expect(await tool.validate({ value: "other" })).toBeDefined();
  const signal = new AbortController().signal;
  expect(await tool.execute({ value: "seed" }, signal)).toEqual({
    content: "EVAL-OK-42",
  });
  expect((await tool.execute({ value: "seed" }, signal)).isError).toBe(true);
});
