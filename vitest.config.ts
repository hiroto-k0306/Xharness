import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const exclude = [
  "Old/retired-sources/**",
  "**/node_modules/**",
  "spike/.out/**",
  ".tools/**",
  "dist/**",
  "out/**",
];

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: [
            "src/**/*.test.ts",
            "test/**/*.test.ts",
            "scripts/**/*.test.ts",
          ],
          exclude,
        },
      },
      {
        // 画面部品とストアは jsdom で試す(Vitest + jsdom)
        extends: true,
        test: {
          name: "renderer",
          environment: "jsdom",
          include: ["src/renderer/**/*.test.{ts,tsx}"],
          exclude,
          setupFiles: ["src/renderer/test-setup.ts"],
        },
      },
    ],
  },
});
