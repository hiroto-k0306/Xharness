import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// main / preload / renderer を一括ビルド(DESIGN.md §17.2)。
export default defineConfig({
  main: {
    build: {
      // Vite 8 は Rolldown を使う。Electron は実行時提供のモジュールなので同梱しない。
      rolldownOptions: {
        input: { index: "src/main/index.ts" },
        external: ["electron", /^electron\//],
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
