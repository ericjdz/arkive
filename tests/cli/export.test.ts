import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { writeArchitecture } from "../../src/io/architecture-file.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";

describe("CLI export command", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-export-"));
    const arch = createEmptyArchitecture("export-test", "Export test");
    arch.services.push(
      {
        id: "web",
        name: "Web Client",
        type: "frontend",
        technology: "Next.js",
        description: "UI",
        dependencies: ["api"],
      },
      {
        id: "api",
        name: "API Server",
        type: "backend",
        technology: "Express",
        description: "REST API",
        dependencies: [],
      }
    );
    arch.connections.push({
      from: "web",
      to: "api",
      protocol: "HTTP/REST",
      description: "API calls",
    });
    arch.decisions.push({
      id: "dec-001",
      topic: "Framework",
      decision: "Next.js",
      rationale: "SSR support",
      alternatives: [{ name: "Vite", whyNot: "No SSR" }],
      timestamp: new Date().toISOString(),
      relatedServices: ["web"],
    });
    const r = writeArchitecture(tempDir, arch);
    if (!r.success) throw new Error(r.error);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exports markdown to stdout by default", () => {
    const output = execSync(
      `npx tsx src/cli/index.ts export --dir "${tempDir}"`,
      { cwd: process.cwd(), encoding: "utf-8", timeout: 30000 }
    );
    expect(output).toContain("# export-test");
    expect(output).toContain("Web Client");
    expect(output).toContain("## Architectural Decisions");
  }, 35000);

  it("exports mermaid format when --format mermaid is specified", () => {
    const output = execSync(
      `npx tsx src/cli/index.ts export --dir "${tempDir}" --format mermaid`,
      { cwd: process.cwd(), encoding: "utf-8", timeout: 30000 }
    );
    expect(output).toContain("graph TD");
    expect(output).toContain("web");
    expect(output).toContain("api");
    expect(output).toContain("HTTP/REST");
  }, 35000);

  it("writes to a file when --output is specified", () => {
    const outFile = join(tempDir, "architecture.md");
    execSync(
      `npx tsx src/cli/index.ts export --dir "${tempDir}" --output "${outFile}"`,
      { cwd: process.cwd(), timeout: 30000 }
    );
    expect(existsSync(outFile)).toBe(true);
    const content = readFileSync(outFile, "utf-8");
    expect(content).toContain("# export-test");
  }, 35000);

  it("exits with error when architecture.json is missing", () => {
    rmSync(tempDir, { recursive: true, force: true });
    expect(() =>
      execSync(
        `npx tsx src/cli/index.ts export --dir "${tempDir}"`,
        { cwd: process.cwd(), encoding: "utf-8", stdio: "pipe", timeout: 30000 }
      )
    ).toThrow();
  }, 35000);
});
