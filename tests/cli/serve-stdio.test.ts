import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

/**
 * Invoked from source via tsx rather than from dist/.
 *
 * Previously this asserted existsSync("dist/cli/index.js") and spawned the
 * built artefact. That coupled the suite to a build output CI has not
 * produced yet at test time, and raced npm-pack.test.ts which rebuilds dist/
 * while other files are running. See reconcile.test.ts for the same rationale.
 */
describe("CLI serve command help", () => {
  it("includes --stdio, --port, and --dir", () => {
    const result = spawnSync("npx", ["tsx", "src/cli/index.ts", "serve", "--help"], {
      encoding: "utf-8",
      shell: true,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--stdio");
    expect(result.stdout).toContain("--port");
    expect(result.stdout).toContain("--dir");
  }, 60_000);
});