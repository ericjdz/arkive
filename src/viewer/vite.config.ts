import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Force ALL React imports (including transitive deps like @xyflow/react)
// to resolve to a single React copy from the root node_modules.
const rootModules = resolve(__dirname, "../../node_modules");

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname),
  resolve: {
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    alias: [
      // Use regex to catch ALL react imports including subpaths
      { find: /^react-dom($|\/)/, replacement: resolve(rootModules, "react-dom") + "/" },
      { find: /^react($|\/)/, replacement: resolve(rootModules, "react") + "/" },
    ],
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
