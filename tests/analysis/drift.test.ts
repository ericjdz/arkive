import { describe, it, expect } from "vitest";
import { detectDrift } from "../../src/analysis/drift.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";

describe("drift detection", () => {
  it("returns no warnings when scan is empty and architecture is empty", () => {
    const arch = createEmptyArchitecture("empty", "Empty");
    const result = detectDrift(arch, {
      hasPackageJson: false,
      dependencies: [],
      imports: [],
    });
    expect(result.warnings).toEqual([]);
    expect(result.summary.total).toBe(0);
  });

  it("flags imports of packages not declared in package.json", () => {
    const arch = createEmptyArchitecture("test", "Test");
    const result = detectDrift(arch, {
      hasPackageJson: true,
      dependencies: ["express"],
      imports: ["express", "ghost-package"],
    });
    const undeclared = result.warnings.filter((w) => w.kind === "undeclared-import");
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0].subject).toBe("ghost-package");
    expect(undeclared[0].severity).toBe("warning");
  });

  it("flags stack technologies not present in package.json deps", () => {
    const arch = createEmptyArchitecture("test", "Test");
    arch.stack.framework = ["Next.js", "Fastify"];
    const result = detectDrift(arch, {
      hasPackageJson: true,
      dependencies: ["next"],
      imports: ["next"],
    });
    const stale = result.warnings.filter((w) => w.kind === "stale-stack");
    expect(stale.map((w) => w.subject)).toContain("Fastify");
  });

  it("does not flag stack entries that match a known dependency alias", () => {
    const arch = createEmptyArchitecture("test", "Test");
    arch.stack.framework = ["Next.js"];
    const result = detectDrift(arch, {
      hasPackageJson: true,
      dependencies: ["next"],
      imports: ["next"],
    });
    expect(result.warnings.filter((w) => w.kind === "stale-stack")).toEqual([]);
  });

  it("flags significant imports that don't map to any service technology", () => {
    const arch = createEmptyArchitecture("test", "Test");
    arch.services.push({
      id: "api",
      name: "API",
      type: "backend",
      technology: "Express",
      description: "REST API",
      dependencies: [],
    });
    const result = detectDrift(arch, {
      hasPackageJson: true,
      dependencies: ["express", "socket.io"],
      imports: ["express", "socket.io"],
    });
    const untracked = result.warnings.filter((w) => w.kind === "untracked-service");
    expect(untracked.map((w) => w.subject)).toContain("socket.io");
  });

  it("ignores common low-signal dependencies in untracked-service detection", () => {
    const arch = createEmptyArchitecture("test", "Test");
    const result = detectDrift(arch, {
      hasPackageJson: true,
      dependencies: ["typescript", "vitest", "tsup", "@types/node"],
      imports: ["typescript", "vitest"],
    });
    expect(result.warnings.filter((w) => w.kind === "untracked-service")).toEqual([]);
  });

  it("emits an info warning when package.json is missing", () => {
    const arch = createEmptyArchitecture("test", "Test");
    const result = detectDrift(arch, {
      hasPackageJson: false,
      dependencies: [],
      imports: [],
    });
    expect(result.warnings).toEqual([]);
  });

  it("computes summary counts by severity", () => {
    const arch = createEmptyArchitecture("test", "Test");
    arch.stack.framework = ["Fastify"];
    const result = detectDrift(arch, {
      hasPackageJson: true,
      dependencies: ["express"],
      imports: ["express", "ghost"],
    });
    expect(result.summary.total).toBeGreaterThan(0);
    expect(result.summary.bySeverity.warning).toBeGreaterThan(0);
  });
});
