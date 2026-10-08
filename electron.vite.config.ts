import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// main / preload / renderer を一括ビルド(DESIGN.md §17.2)。
export default defineConfig({
  main: {
    plugins: [
      {
        name: "typescript-esm-paths",
        transform(code, id) {
          if (
            !id.replaceAll("\\", "/").endsWith("/typescript/lib/typescript.js")
          )
            return;
          // TypeScript's CommonJS system initializes before electron-vite's
          // generated ESM path constants. Bind only this bundled module's paths.
          return code
            .replace(/\b__filename\b/g, "import.meta.filename")
            .replace(/\b__dirname\b/g, "import.meta.dirname");
        },
      },
    ],
    build: {
      // Vite 8 は Rolldown を使う。Electron は実行時提供のモジュールなので同梱しない。
      rolldownOptions: {
        input: {
          index: "src/main/index.ts",
          "sdk-worker": "src/main/workflow/official/sdk-worker.ts",
        },
        external: ["electron", /^electron\//, "@anthropic-ai/claude-agent-sdk"],
      },
    },
  },
  preload: {
    build: {
      rolldownOptions: {
        input: { index: "src/preload/index.ts" },
        external: ["electron", /^electron\//],
        // sandbox: true の preload は CommonJS でなければ読み込めない
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    // 厳格な CSP のまま開発起動する。Refresh の inline preamble と WebSocket は使わない。
    server: { host: "127.0.0.1", hmr: false },
    build: {
      rolldownOptions: {
        input: fileURLToPath(
          new URL("./src/renderer/index.html", import.meta.url),
        ),
      },
    },
  },
});
