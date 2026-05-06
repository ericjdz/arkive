import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleScaffoldProject } from "../../src/server/tools.js";

describe("scaffold_project MCP tool", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-scaffold-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates architecture.json and instruction files", async () => {
    const result = await handleScaffoldProject({
      projectPath: tempDir,
      projectName: "test-project",
    });

    expect(result.isError).toBeUndefined();

    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.filesCreated).toContain("architecture.json");

    expect(existsSync(join(tempDir, "architecture.json"))).toBe(true);
    expect(existsSync(join(tempDir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(tempDir, "AGENTS.md"))).toBe(true);

    const agents = readFileSync(join(tempDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("On EVERY session start");
  });

  it("does not overwrite existing architecture.json", async () => {
    const archPath = join(tempDir, "architecture.json");
    const originalContent = '{"existing": true}';
    writeFileSync(archPath, originalContent, "utf-8");

    const result = await handleScaffoldProject({
      projectPath: tempDir,
    });

    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.filesCreated).not.toContain("architecture.json");
    expect(body.filesSkipped).toContain("architecture.json");

    expect(readFileSync(archPath, "utf-8")).toBe(originalContent);
  });

  it("supports standalone mode", async () => {
    const result = await handleScaffoldProject({
      projectPath: tempDir,
      standalone: true,
    });

    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);

    const claude = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    expect(claude).not.toContain("arkive:start");
  });
});
