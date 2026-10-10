import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { ARKIVE_DIR } from "../../src/io/architecture-file.js";

/**
 * Every test in this file spawns `npx tsx`, which costs several seconds on a
 * loaded machine. The default 5s budget, and even 20s, is not enough when
 * several workers and a package build are competing for the CPU.
 */
const CLI_TIMEOUT = 60_000;

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
    const archPath = join(tempDir, "arkive", "architecture.json");
    expect(existsSync(archPath)).toBe(true);

    const arch = JSON.parse(readFileSync(archPath, "utf-8"));
    expect(arch.project.name).toBe("test-project");
    // A new project is born at the current schema version, not at v1 and
    // migrated on first write. `version` is gone: it was a defaulted semver
    // string that nothing branched on (ADR-0001:121-127).
    expect(arch.schemaVersion).toBe(2);
    expect(arch.version).toBeUndefined();
    expect(arch.nodes).toEqual([]);
    expect(arch.edges).toEqual([]);
  }, CLI_TIMEOUT);

  it("creates arkive directory structure with history and context subdirs", () => {
    execSync(`npx tsx src/cli/index.ts init --name test-project --dir "${tempDir}"`, {
      cwd: process.cwd(),
    });
    expect(existsSync(join(tempDir, ARKIVE_DIR))).toBe(true);
    expect(existsSync(join(tempDir, ARKIVE_DIR, "history"))).toBe(true);
    expect(existsSync(join(tempDir, ARKIVE_DIR, "context", "sessions"))).toBe(true);
  }, CLI_TIMEOUT);

  it("creates CLAUDE.md in target directory", () => {
    execSync(`npx tsx src/cli/index.ts init --name test-project --dir "${tempDir}"`, {
      cwd: process.cwd(),
    });
    const claudePath = join(tempDir, "CLAUDE.md");
    expect(existsSync(claudePath)).toBe(true);

    const content = readFileSync(claudePath, "utf-8");
    expect(content).toContain("<!-- arkive:start -->");
    expect(content).toContain("arkive/architecture.json");
    expect(content).toContain("<!-- arkive:end -->");
  }, CLI_TIMEOUT);

  it("creates AGENTS.md in target directory", () => {
    execSync(`npx tsx src/cli/index.ts init --name test-project --dir "${tempDir}"`, {
      cwd: process.cwd(),
    });
    const agentsPath = join(tempDir, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(true);

    const content = readFileSync(agentsPath, "utf-8");
    expect(content).toContain("<!-- arkive:start -->");
    expect(content).toContain("arkive/architecture.json");
    expect(content).toContain("<!-- arkive:end -->");
  }, CLI_TIMEOUT);

  it("creates .cursor/rules directory and rule file", () => {
    execSync(`npx tsx src/cli/index.ts init --name test-project --dir "${tempDir}"`, {
      cwd: process.cwd(),
    });
    const cursorPath = join(tempDir, ".cursor", "rules", "architecture-tracker.mdc");
    expect(existsSync(cursorPath)).toBe(true);
  }, CLI_TIMEOUT);

  it("does not overwrite existing architecture.json", () => {
    mkdirSync(join(tempDir, "arkive"), { recursive: true });
    const archPath = join(tempDir, "arkive", "architecture.json");
    const existingContent = '{"existing": true}';
    writeFileSync(archPath, existingContent);

    execSync(`npx tsx src/cli/index.ts init --name test-project --dir "${tempDir}"`, {
      cwd: process.cwd(),
    });

    const content = readFileSync(archPath, "utf-8");
    expect(content).toBe(existingContent);
  }, CLI_TIMEOUT);

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
  }, CLI_TIMEOUT);

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
  }, CLI_TIMEOUT);

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
  }, CLI_TIMEOUT);

  it("generates full files with --standalone flag", () => {
    execSync(`npx tsx src/cli/index.ts init --name test-project --dir "${tempDir}" --standalone`, {
      cwd: process.cwd(),
    });

    const claudePath = join(tempDir, "CLAUDE.md");
    const content = readFileSync(claudePath, "utf-8");
    expect(content).toContain("The Three Rules");
    expect(content).not.toContain("<!-- arkive:start -->");
  }, CLI_TIMEOUT);

  it("infers project name from directory if not provided", () => {
    execSync(`npx tsx src/cli/index.ts init --dir "${tempDir}"`, {
      cwd: process.cwd(),
    });
    const archPath = join(tempDir, "arkive", "architecture.json");
    const arch = JSON.parse(readFileSync(archPath, "utf-8"));
    expect(arch.project.name).toBeTruthy();
  }, CLI_TIMEOUT);
});
