import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Force ALL React imports to resolve to the root node_modules (React 19)
// to prevent duplicate React instances from viewer's own node_modules
const rootModules = resolve(__dirname, "../../node_modules");

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname),
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      react: resolve(rootModules, "react"),
      "react-dom": resolve(rootModules, "react-dom"),
      "react/jsx-runtime": resolve(rootModules, "react/jsx-runtime"),
      "react/jsx-dev-runtime": resolve(rootModules, "react/jsx-dev-runtime"),
    },
  },
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
