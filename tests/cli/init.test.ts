import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

describe("CLI init command", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "archlearn-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates architecture.json in target directory", () => {
    execSync(`npx tsx src/cli/index.ts init --name test-project --dir "${tempDir}"`, {
      cwd: process.cwd(),
    });
    const archPath = join(tempDir, "architecture.json");
    expect(existsSync(archPath)).toBe(true);

    const arch = JSON.parse(readFileSync(archPath, "utf-8"));
    expect(arch.project.name).toBe("test-project");
    expect(arch.version).toBe("1.0.0");
  }, 20000);

  it("creates CLAUDE.md in target directory", () => {
    execSync(`npx tsx src/cli/index.ts init --name test-project --dir "${tempDir}"`, {
      cwd: process.cwd(),
    });
    const claudePath = join(tempDir, "CLAUDE.md");
    expect(existsSync(claudePath)).toBe(true);

    const content = readFileSync(claudePath, "utf-8");
    expect(content).toContain("test-project");
    expect(content).toContain("architecture.json");
  }, 20000);

  it("creates AGENTS.md in target directory", () => {
    execSync(`npx tsx src/cli/index.ts init --name test-project --dir "${tempDir}"`, {
      cwd: process.cwd(),
    });
    const agentsPath = join(tempDir, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(true);
  }, 20000);

  it("creates .cursor/rules directory and rule file", () => {
    execSync(`npx tsx src/cli/index.ts init --name test-project --dir "${tempDir}"`, {
      cwd: process.cwd(),
    });
    const cursorPath = join(tempDir, ".cursor", "rules", "architecture-tracker.mdc");
    expect(existsSync(cursorPath)).toBe(true);
  }, 20000);

  it("does not overwrite existing architecture.json", () => {
    const archPath = join(tempDir, "architecture.json");
    const existingContent = '{"existing": true}';
    writeFileSync(archPath, existingContent);

    execSync(`npx tsx src/cli/index.ts init --name test-project --dir "${tempDir}"`, {
      cwd: process.cwd(),
    });

    const content = readFileSync(archPath, "utf-8");
    expect(content).toBe(existingContent);
  }, 20000);

  it("infers project name from directory if not provided", () => {
    execSync(`npx tsx src/cli/index.ts init --dir "${tempDir}"`, {
      cwd: process.cwd(),
    });
    const archPath = join(tempDir, "architecture.json");
    const arch = JSON.parse(readFileSync(archPath, "utf-8"));
    expect(arch.project.name).toBeTruthy();
  }, 20000);
});
