import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

/**
 * Invoked from source via tsx rather than from dist/.
 *
 * This test previously shelled out to dist/cli/index.js, which made it
 * depend on a build artefact that does not exist on a fresh checkout (CI ran
 * test before build) and raced tests/package/npm-pack.test.ts, which rebuilds
 * dist/ mid-suite. Command registration is source-level behaviour; the built
 * artefact is covered by the npm pack + install + bin invocation test.
 */
describe("reconcile command", () => {
  it("is registered in the CLI", () => {
    const help = execSync("npx tsx src/cli/index.ts --help", { encoding: "utf8" });
    expect(help).toContain("reconcile");
  }, 60_000);

  it("shows help with --dir option", () => {
    const help = execSync("npx tsx src/cli/index.ts reconcile --help", { encoding: "utf8" });
    expect(help).toContain("--dir");
    expect(help).toContain("Detect drift");
  }, 60_000);
});