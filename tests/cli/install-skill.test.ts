import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
    expect(existsSync(join(result.skillDir, "process-prompts", "SKILL.md"))).toBe(true);
    // Issue 0014 dogfood: the walkthrough skill shipped in 0009 but was never
    // installed — the process-prompts omission c4df919 had to repair, repeated.
    expect(existsSync(join(result.skillDir, "walkthrough", "SKILL.md"))).toBe(true);
  });

  it("installs every skill the repo ships (registry matches source)", () => {
    // A shipped skill that is never installed is silent loss of the exact
    // kind c4df919 repaired for process-prompts. Enumerate the source tree
    // (top level plus one layer down) and require the install set to match.
    const skillsRoot = join(__dirname, "..", "..", "skills");
    const source: string[] = [];
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const inner = join(skillsRoot, entry.name);
      if (existsSync(join(inner, "SKILL.md"))) {
        source.push(entry.name);
        continue;
      }
      for (const sub of readdirSync(inner, { withFileTypes: true })) {
        if (sub.isDirectory() && existsSync(join(inner, sub.name, "SKILL.md"))) {
          source.push(sub.name);
        }
      }
    }
    expect(source.length).toBeGreaterThan(0);

    const result = installSkills({
      platform: "opencode",
      targetDir: tempDir,
    });
    expect(readdirSync(result.skillDir).sort()).toEqual(source.sort());
    expect(result.skillsCopied).toBe(source.length);
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
