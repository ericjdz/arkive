import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Per-file environments are declared with `// @vitest-environment jsdom`
    // docblocks rather than `environmentMatchGlobs`, which vitest 4 removed.

    /**
     * Many tests here do real filesystem work: they create temp project
     * trees, write documents, and run the scanner over them. The vitest
     * default is 5000ms, which is under the floor for that on a loaded
     * machine - it produced intermittent timeouts that varied run to run
     * and masked whether anything was genuinely broken.
     *
     * Measured: `stop()` on a clean fixture is 11-23ms. The timeouts were
     * harness contention, not slow code, but the remedy belongs in the
     * harness. 20s is far below the point where a hung test would be
     * mistaken for a slow one.
     *
     * Tests that spawn a subprocess (`npx tsx`) carry their own 60s budget,
     * because process startup genuinely dominates there.
     */
    testTimeout: 20_000,

    /**
     * The wall-clock budget test runs alone, via `npm run test:perf` and
     * vitest.perf.config.ts. See that file for why: it measures 5,000 files
     * in under 5s, ~95% of which is syscalls, so a saturated machine
     * produces failures that are neither regressions nor reproducible.
     */
    exclude: [...configDefaults.exclude, "tests/analysis/performance.test.ts"],
  },
});