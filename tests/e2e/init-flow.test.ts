import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { validateArchitecture } from "../../src/schema/validate.js";

describe("E2E: init flow", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "archlearn-e2e-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("full init flow produces valid architecture.json and all instruction files", () => {
    // Run init
    execSync(
      `npx tsx src/cli/index.ts init --name "e2e-test-app" --description "End to end test project" --dir "${tempDir}"`,
      { cwd: process.cwd() }
    );

    // Verify architecture.json exists and validates
    const archPath = join(tempDir, "architecture.json");
    expect(existsSync(archPath)).toBe(true);
    const archData = JSON.parse(readFileSync(archPath, "utf-8"));
    const validation = validateArchitecture(archData);
    expect(validation.success).toBe(true);
    if (validation.success) {
      expect(validation.data.project.name).toBe("e2e-test-app");
      expect(validation.data.project.description).toBe("End to end test project");
      expect(validation.data.history).toHaveLength(1);
      expect(validation.data.history[0].action).toBe("initial_scaffold");
    }

    // Verify CLAUDE.md
    const claudePath = join(tempDir, "CLAUDE.md");
    expect(existsSync(claudePath)).toBe(true);
    const claudeContent = readFileSync(claudePath, "utf-8");
    expect(claudeContent).toContain("e2e-test-app");
    expect(claudeContent).toContain("architecture.json");
    expect(claudeContent).toContain("Before making any major change");

    // Verify AGENTS.md
    const agentsPath = join(tempDir, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(true);
    const agentsContent = readFileSync(agentsPath, "utf-8");
    expect(agentsContent).toContain("e2e-test-app");

    // Verify Cursor rule
    const cursorPath = join(tempDir, ".cursor", "rules", "architecture-tracker.mdc");
    expect(existsSync(cursorPath)).toBe(true);
    const cursorContent = readFileSync(cursorPath, "utf-8");
    expect(cursorContent).toContain("alwaysApply: true");
  });

  it("running init twice does not overwrite existing files", () => {
    // First init
    execSync(
      `npx tsx src/cli/index.ts init --name "first-run" --dir "${tempDir}"`,
      { cwd: process.cwd() }
    );

    const archPath = join(tempDir, "architecture.json");
    const firstContent = readFileSync(archPath, "utf-8");

    // Second init with different name
    execSync(
      `npx tsx src/cli/index.ts init --name "second-run" --dir "${tempDir}"`,
      { cwd: process.cwd() }
    );

    const secondContent = readFileSync(archPath, "utf-8");
    expect(secondContent).toBe(firstContent); // Not overwritten
    expect(JSON.parse(secondContent).project.name).toBe("first-run");
  }, 15000);
});
