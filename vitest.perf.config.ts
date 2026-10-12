import { defineConfig } from "vitest/config";

/**
 * Performance runs alone.
 *
 * tests/analysis/performance.test.ts asserts a wall-clock budget: 5,000 files
 * scanned in under 5s. Roughly 95% of that is filesystem syscalls, so the
 * number is a direct function of how busy the machine is — measured identical
 * code at 2,500ms on an idle box and 18,000ms while two other suites ran.
 *
 * It already takes the fastest of five runs and prints all five, which is the
 * right mitigation, but a minimum over five still cannot beat a machine that
 * is saturated for all five. Contention therefore produced failures that were
 * not regressions and were not reproducible, which is the one thing a test
 * must never be.
 *
 * So it runs here, alone, rather than beside 90 other files. The budget is
 * unchanged and the assertion is untouched — it is simply measured on a
 * machine that is not doing anything else, which is the condition the budget
 * was written for.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/analysis/performance.test.ts"],
    // Five runs of a 5,000-file scan, plus fixture construction.
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});