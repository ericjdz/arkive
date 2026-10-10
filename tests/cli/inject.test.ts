import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { injectArkiveBlock, MARKER_START, MARKER_END } from "../../src/cli/commands/inject.js";
import { renderTemplate } from "../../src/templates/render.js";

const BLOCK = `${MARKER_START}\n## arkive\nTracking enabled.\n${MARKER_END}`;

describe("injectArkiveBlock", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-inject-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates file with block when file does not exist", () => {
    const filePath = join(tempDir, "NEW.md");
    injectArkiveBlock(filePath, BLOCK);
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe(BLOCK + "\n");
  });

  it("appends block to existing file without markers", () => {
    const filePath = join(tempDir, "EXISTING.md");
    writeFileSync(filePath, "# My Project\n\nCustom instructions here.\n", "utf-8");
    injectArkiveBlock(filePath, BLOCK);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("# My Project");
    expect(content).toContain("Custom instructions here.");
    expect(content).toContain(MARKER_START);
    expect(content).toContain("Tracking enabled.");
    expect(content).toContain(MARKER_END);
  });

  it("replaces existing block between markers", () => {
    const filePath = join(tempDir, "UPDATE.md");
    const oldBlock = `${MARKER_START}\nOld content.\n${MARKER_END}`;
    writeFileSync(filePath, `# My Project\n\n${oldBlock}\n\n## Other Section\n`, "utf-8");
    const newBlock = `${MARKER_START}\nNew content.\n${MARKER_END}`;
    injectArkiveBlock(filePath, newBlock);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("# My Project");
    expect(content).toContain("New content.");
    expect(content).not.toContain("Old content.");
    expect(content).toContain("## Other Section");
  });

  it("preserves content before and after markers exactly", () => {
    const filePath = join(tempDir, "PRESERVE.md");
    const before = "# Title\n\nSome intro text.\n";
    const after = "\n## Footer\n\nEnd of file.\n";
    const oldBlock = `${MARKER_START}\nOld.\n${MARKER_END}`;
    writeFileSync(filePath, before + "\n" + oldBlock + after, "utf-8");
    const newBlock = `${MARKER_START}\nNew.\n${MARKER_END}`;
    injectArkiveBlock(filePath, newBlock);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("# Title");
    expect(content).toContain("Some intro text.");
    expect(content).toContain("## Footer");
    expect(content).toContain("End of file.");
    expect(content).toContain("New.");
    expect(content).not.toContain("Old.");
  });

  it("does not duplicate block on repeated runs", () => {
    const filePath = join(tempDir, "IDEM.md");
    writeFileSync(filePath, "# Existing\n", "utf-8");
    injectArkiveBlock(filePath, BLOCK);
    injectArkiveBlock(filePath, BLOCK);
    injectArkiveBlock(filePath, BLOCK);
    const content = readFileSync(filePath, "utf-8");
    const starts = content.split(MARKER_START).length - 1;
    expect(starts).toBe(1);
  });

  it("creates parent directories if needed", () => {
    const filePath = join(tempDir, "nested", "deep", "AGENTS.md");
    injectArkiveBlock(filePath, BLOCK);
    expect(existsSync(filePath)).toBe(true);
  });

  it("renders arkive block with lifecycle hook directives", () => {
    const rendered = renderTemplate("arkive-block.md.hbs", {
      projectName: "test-project",
      architectureFile: "arkive/architecture.json",
    });

    expect(rendered).toContain("On EVERY session start");
    expect(rendered).toContain("After EVERY major change");
    expect(rendered).toContain("Before claiming ANY task is complete");
    expect(rendered).toContain("arkive:start");
    expect(rendered).toContain("arkive:end");
  });
});
