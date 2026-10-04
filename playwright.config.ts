import { defineConfig } from "@playwright/test";

export default defineConfig({
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
