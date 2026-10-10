import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Per-file environments are declared with `// @vitest-environment jsdom`
    // docblocks rather than `environmentMatchGlobs`, which vitest 4 removed.
  },
});