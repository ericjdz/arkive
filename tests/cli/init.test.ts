import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

describe("CLI init command", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-test-"));
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
    expect(content).toContain("<!-- arkive:start -->");
    expect(content).toContain("architecture.json");
    expect(content).toContain("<!-- arkive:end -->");
  }, 20000);

  it("creates AGENTS.md in target directory", () => {
    execSync(`npx tsx src/cli/index.ts init --name test-project --dir "${tempDir}"`, {
      cwd: process.cwd(),
    });
    const agentsPath = join(tempDir, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(true);

    const content = readFileSync(agentsPath, "utf-8");
    expect(content).toContain("<!-- arkive:start -->");
    expect(content).toContain("architecture.json");
    expect(content).toContain("<!-- arkive:end -->");
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

  it("injects arkive block into existing AGENTS.md without replacing content", () => {
    const agentsPath = join(tempDir, "AGENTS.md");
    const existingContent = "# My custom agent notes\n\nKeep this content.";
    writeFileSync(agentsPath, existingContent, "utf-8");

    execSync(`npx tsx src/cli/index.ts init --name test-project --dir "${tempDir}"`, {
      cwd: process.cwd(),
    });

    const content = readFileSync(agentsPath, "utf-8");
    expect(content).toContain(existingContent);
    expect(content).toContain("<!-- arkive:start -->");
    expect(content).toContain("<!-- arkive:end -->");
  }, 20000);

  it("injects arkive block into existing CLAUDE.md without replacing content", () => {
    const claudePath = join(tempDir, "CLAUDE.md");
    const existingContent = "# My custom Claude notes\n\nKeep this content.";
    writeFileSync(claudePath, existingContent, "utf-8");

    execSync(`npx tsx src/cli/index.ts init --name test-project --dir "${tempDir}"`, {
      cwd: process.cwd(),
    });

    const content = readFileSync(claudePath, "utf-8");
    expect(content).toContain(existingContent);
    expect(content).toContain("<!-- arkive:start -->");
    expect(content).toContain("<!-- arkive:end -->");
  }, 20000);

  it("replaces arkive block on re-run without duplicating", () => {
    execSync(`npx tsx src/cli/index.ts init --name test-project --dir "${tempDir}"`, {
      cwd: process.cwd(),
    });

    execSync(`npx tsx src/cli/index.ts init --name test-project --dir "${tempDir}"`, {
      cwd: process.cwd(),
    });

    const agentsPath = join(tempDir, "AGENTS.md");
    const content = readFileSync(agentsPath, "utf-8");
    expect(content.match(/<!-- arkive:start -->/g)).toHaveLength(1);
  }, 20000);

  it("generates full files with --standalone flag", () => {
    execSync(`npx tsx src/cli/index.ts init --name test-project --dir "${tempDir}" --standalone`, {
      cwd: process.cwd(),
    });

    const claudePath = join(tempDir, "CLAUDE.md");
    const content = readFileSync(claudePath, "utf-8");
    expect(content).toContain("The Three Rules");
    expect(content).not.toContain("<!-- arkive:start -->");
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
