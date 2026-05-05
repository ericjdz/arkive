import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runStatus, formatStatus } from "../../src/cli/commands/status.js";
import { writeArchitecture } from "../../src/io/architecture-file.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";

describe("CLI status command", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-status-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns ok=false when architecture.json is missing", async () => {
    const result = await runStatus({ dir: tempDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not found");
    }
  });

  it("returns counts and lastUpdated when architecture exists", async () => {
    const arch = createEmptyArchitecture("status-test", "Status");
    arch.services.push({
      id: "web", name: "Web", type: "frontend",
      technology: "Next.js", description: "UI", dependencies: [],
    });
    arch.decisions.push({
      id: "dec-001", topic: "T", decision: "D", rationale: "R",
      alternatives: [{ name: "A", whyNot: "B" }],
      timestamp: new Date().toISOString(), relatedServices: [],
    });
    writeArchitecture(tempDir, arch);

    const result = await runStatus({ dir: tempDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.project.name).toBe("status-test");
      expect(result.report.counts.services).toBe(1);
      expect(result.report.counts.decisions).toBe(1);
      expect(result.report.lastUpdated).toBeDefined();
    }
  });

  it("includes drift report when package.json is present", async () => {
    const arch = createEmptyArchitecture("drift-status", "Drift");
    arch.stack.framework = ["Fastify"];
    writeArchitecture(tempDir, arch);
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      "utf-8"
    );

    const result = await runStatus({ dir: tempDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.drift.summary.total).toBeGreaterThan(0);
      expect(
        result.report.drift.warnings.some((w) => w.subject === "Fastify")
      ).toBe(true);
    }
  });

  it("formatStatus produces a human-readable string", async () => {
    const arch = createEmptyArchitecture("fmt", "Fmt");
    writeArchitecture(tempDir, arch);
    const result = await runStatus({ dir: tempDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const text = formatStatus(result.report);
      expect(text).toContain("fmt");
      expect(text).toContain("Services:");
      expect(text).toContain("Decisions:");
      expect(text).toContain("Last updated:");
    }
  });
});
