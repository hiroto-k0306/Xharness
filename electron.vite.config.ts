import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

// main / preload / renderer を一括ビルド(DESIGN.md §17.2)。
export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: "src/main/index.ts" } } },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        // sandbox: true の preload は CommonJS でなければ読み込めない
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    build: { rollupOptions: { input: "src/renderer/index.html" } },
  },
});
