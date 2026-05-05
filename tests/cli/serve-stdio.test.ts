import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

describe("CLI serve command help", () => {
  it("includes --stdio, --port, and --dir", () => {
    expect(existsSync("dist/cli/index.js")).toBe(true);

    const result = spawnSync(process.execPath, ["dist/cli/index.js", "serve", "--help"], {
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--stdio");
    expect(result.stdout).toContain("--port");
    expect(result.stdout).toContain("--dir");
  });
});
