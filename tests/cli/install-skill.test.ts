import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installSkills, resolveSkillDir } from "../../src/cli/commands/install-skill.js";

describe("install-skill command", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-skill-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("copies skill files to target directory for opencode", () => {
    const result = installSkills({
      platform: "opencode",
      targetDir: tempDir,
    });

    expect(result.skillsCopied).toBeGreaterThan(0);
    expect(result.skillDir).toContain(".opencode");

    expect(existsSync(join(result.skillDir, "arkive-init", "SKILL.md"))).toBe(true);
    expect(existsSync(join(result.skillDir, "arkive-import", "SKILL.md"))).toBe(true);
    expect(existsSync(join(result.skillDir, "arkive-view", "SKILL.md"))).toBe(true);
    expect(existsSync(join(result.skillDir, "architecture-tracker", "SKILL.md"))).toBe(true);
  });

  it("injects skill content into instruction file for cursor", () => {
    const result = installSkills({
      platform: "cursor",
      targetDir: tempDir,
    });

    expect(result.skillsCopied).toBeGreaterThan(0);

    const mdcPath = join(tempDir, ".cursor", "rules", "arkive-init.mdc");
    expect(existsSync(mdcPath)).toBe(true);

    const content = readFileSync(mdcPath, "utf-8");
    expect(content).toContain("arkive-init");
  });

  it("injects skill content into AGENTS.md for vscode", () => {
    const result = installSkills({
      platform: "vscode",
      targetDir: tempDir,
    });

    expect(result.skillsCopied).toBeGreaterThan(0);

    const agentsPath = join(tempDir, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(true);

    const content = readFileSync(agentsPath, "utf-8");
    expect(content).toContain("arkive-init");
    expect(content).toContain("arkive-import");
  });

  it("resolves skill directory per platform", () => {
    const dir = resolveSkillDir("opencode", tempDir, false);
    expect(dir).toContain(".opencode");
  });
});
