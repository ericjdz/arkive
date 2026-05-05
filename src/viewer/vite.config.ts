import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname),
  build: {
    outDir: resolve(__dirname, "../../dist/viewer"),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:4567",
    },
  },
});
