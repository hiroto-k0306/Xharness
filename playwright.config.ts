import { defineConfig } from "@playwright/test";

export default defineConfig({
  projects: [
    {
      name: process.env.XHARNESS_TEST_EXECUTABLE ? "packaged" : "development",
      testIgnore: process.env.XHARNESS_TEST_EXECUTABLE
        ? [
            "**/connections.spec.ts",
            "**/connection-profile.spec.ts",
            "**/siwc.spec.ts",
          ]
        : ["**/packaged-entry.spec.ts"],
    },
  ],
  testDir: "./test/gui",
  testMatch: "**/*.spec.ts",
  outputDir: ".out/gui",
  // 可視の Electron を毎回分離して起動する。失敗を自動再試行で隠さない。
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: "list",
});
