import { defineConfig } from "@playwright/test";
import current from "./playwright.config.js";

// Historical cases are opt-in and retain their old setup/expectations for review.
export default defineConfig({
  ...current,
  projects: [{ name: "archived-legacy" }],
  testDir: "./test/archived/gui",
  outputDir: ".out/gui-archived",
});
