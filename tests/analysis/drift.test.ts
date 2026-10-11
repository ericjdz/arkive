import { describe, it, expect } from "vitest";
import { detectDrift } from "../../src/analysis/drift.js";
import type { DriftReport, DriftScan } from "../../src/analysis/drift.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";
import type { Architecture } from "../../src/schema/types.js";

/**
 * A complete, honest scan. Every rule below reasons from it, so a test that
 * means "no drift" has to say what was actually examined.
 *
 * The default is `filesScanned: 1` with `parseCoverage: 1`. A rule that reports
 * nothing because it looked at nothing is not reporting agreement, and this
 * file's whole reason for existing is to stop that reading as agreement.
 *
 * Typed as `DriftScan` rather than `ScanResult` on purpose: a rule's input is
 * what the rule reads, and widening it back to the whole scan would make every
 * future field a breaking change here.
 */
function scan(overrides: Partial<DriftScan> = {}): DriftScan {
  return {
    hasPackageJson: true,
    dependencies: [],
    imports: [],
    parseCoverage: 1,
    filesScanned: 1,
    filesUnreadable: 0,
    filesTruncated: 0,
    bytesScanned: 128,
    roots: ["src"],
    truncated: false,
    scanNotes: [],
    ...overrides,
  };
}

function kinds(report: DriftReport, kind: string) {
  return report.warnings.filter((w) => w.kind === kind);
}

describe("drift detection", () => {
  it("returns no warnings when scan is empty and architecture is empty", () => {
    const arch = createEmptyArchitecture("empty", "Empty");
    const result = detectDrift(arch, scan({ hasPackageJson: false }));
    // A project with no manifest cannot be verified at all, and saying so is
    // the whole point. `conclusive: false` is what stops `reconcile` from
    // printing "in sync" over it.
    expect(kinds(result, "missing-manifest")).toHaveLength(1);
    expect(result.conclusive).toBe(false);
    expect(result.summary.bySeverity.critical).toBeGreaterThan(0);
  });

  it("flags imports of packages not declared in package.json", () => {
    const arch = createEmptyArchitecture("test", "Test");
    const result = detectDrift(arch, scan({ dependencies: ["express"], imports: ["express", "ghost-package"] }));
    const undeclared = kinds(result, "undeclared-import");
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0].subject).toBe("ghost-package");
    expect(undeclared[0].severity).toBe("warning");
  });

  it("flags stack technologies not present in package.json deps", () => {
    const arch = createEmptyArchitecture("test", "Test");
    arch.stack.framework = ["Next.js", "Fastify"];
    const result = detectDrift(arch, scan({ dependencies: ["next"], imports: ["next"] }));
    expect(kinds(result, "stale-stack").map((w) => w.subject)).toContain("Fastify");
  });

  it("does not flag stack entries that match a known dependency alias", () => {
    const arch = createEmptyArchitecture("test", "Test");
    arch.stack.framework = ["Next.js"];
    const result = detectDrift(arch, scan({ dependencies: ["next"], imports: ["next"] }));
    expect(kinds(result, "stale-stack")).toEqual([]);
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
    const result = detectDrift(arch, scan({ dependencies: ["express", "socket.io"], imports: ["express", "socket.io"] }));
    expect(kinds(result, "untracked-service").map((w) => w.subject)).toContain("socket.io");
  });

  it("ignores common low-signal dependencies in untracked-service detection", () => {
    const arch = createEmptyArchitecture("test", "Test");
    const result = detectDrift(arch, scan({ dependencies: ["typescript", "vitest", "tsup", "@types/node"], imports: ["typescript", "vitest"] }));
    expect(kinds(result, "untracked-service")).toEqual([]);
  });

  it("computes summary counts by severity", () => {
    const arch = createEmptyArchitecture("test", "Test");
    arch.stack.framework = ["Fastify"];
    const result = detectDrift(arch, scan({ dependencies: ["express"], imports: ["express", "ghost"] }));
    expect(result.summary.total).toBeGreaterThan(0);
    expect(result.summary.bySeverity.warning).toBeGreaterThan(0);
  });

  describe("confidence-aware drift", () => {
    it("flags low-confidence services as warnings", () => {
      const arch = createEmptyArchitecture("test", "Test");
      arch.services = [
        {
          id: "api",
          name: "API",
          type: "backend",
          technology: "Express",
          description: "Main API",
          dependencies: [],
          source: "inferred" as any,
          confidence: 0.3 as any,
        },
      ];

      const report = detectDrift(arch, scan());
      const lowConf = report.warnings.find((w) => w.kind === "low-confidence");
      expect(lowConf).toBeDefined();
      expect(lowConf!.subject).toBe("api");
      expect(lowConf!.severity).toBe("warning");
    });

    it("does not flag high-confidence services", () => {
      const arch = createEmptyArchitecture("test", "Test");
      arch.services = [
        {
          id: "api",
          name: "API",
          type: "backend",
          technology: "Express",
          description: "Main API",
          dependencies: [],
          source: "human-verified" as any,
          confidence: 1 as any,
        },
      ];

      const report = detectDrift(arch, scan());
      expect(report.warnings.find((w) => w.kind === "low-confidence")).toBeUndefined();
    });
  });
});

/**
 * The false-confidence bug.
 *
 * `src/analysis/scanner.ts` used to scan `<root>/src` and nothing else. A
 * project laid out as `lib/`, `app/` or `packages/` produced `imports: []`,
 * every rule above found nothing to say, and `arkive reconcile` printed "in
 * sync" on a document it had never looked at.
 *
 * Silence from a detector is only evidence when the detector looked.
 */
describe("the scan reports on itself", () => {
  const arch = createEmptyArchitecture("quiet", "Quiet");

  it("a partial parse is critical and makes the report inconclusive", () => {
    const result = detectDrift(arch, scan({ parseCoverage: 0.6, filesScanned: 6, filesUnreadable: 4 }));

    const incomplete = kinds(result, "incomplete-scan");
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].severity).toBe("critical");
    expect(result.conclusive).toBe(false);
  });

  it("a truncated walk is critical even at full coverage", () => {
    const result = detectDrift(arch, scan({ truncated: true, filesTruncated: 900 }));
    expect(kinds(result, "incomplete-scan")[0].severity).toBe("critical");
    expect(result.conclusive).toBe(false);
  });

  it("a scan that found no source files at all is critical, not clean", () => {
    // This is the `src`-assumption bug reproduced exactly: a manifest, no
    // source read, zero findings, previously reported as "in sync".
    const result = detectDrift(arch, scan({ filesScanned: 0, parseCoverage: 1 }));

    const incomplete = kinds(result, "incomplete-scan");
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].severity).toBe("critical");
    expect(result.conclusive).toBe(false);
  });

  it("a missing manifest is critical: nothing can be checked against nothing", () => {
    const result = detectDrift(arch, scan({ hasPackageJson: false }));
    expect(kinds(result, "missing-manifest")[0].severity).toBe("critical");
    expect(result.conclusive).toBe(false);
  });

  it("suppresses import rules rather than reporting them from partial evidence", () => {
    // Before this, a 0%-coverage scan produced an undeclared-import warning per
    // import it half-saw. Silence now means "not checked", which `conclusive`
    // states out loud.
    const partial = detectDrift(arch, scan({ parseCoverage: 0.5, filesScanned: 1, filesUnreadable: 1, imports: ["ghost"] }));
    expect(kinds(partial, "undeclared-import")).toHaveLength(0);
    expect(kinds(partial, "incomplete-scan")).toHaveLength(1);
  });

  it("still runs the rules a partial scan can legitimately support", () => {
    // `stale-stack` compares package.json to the document. It needs the
    // manifest, not the source walk, so suppressing it would be over-correcting.
    const withStack = createEmptyArchitecture("partial", "Partial");
    withStack.stack.framework = ["Fastify"];
    const result = detectDrift(withStack, scan({ parseCoverage: 0.5, filesScanned: 1, filesUnreadable: 1 }));
    expect(kinds(result, "stale-stack").map((w) => w.subject)).toContain("Fastify");
  });

  it("a complete scan of a complete project is conclusive and can be empty", () => {
    const result = detectDrift(arch, scan());
    expect(result.conclusive).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("`critical` is reachable at all — it was declared and never emitted", () => {
    expect(kinds(detectDrift(arch, scan({ filesScanned: 0 })), "incomplete-scan")[0].severity).toBe("critical");
    expect(detectDrift(arch, scan()).summary.bySeverity.critical).toBe(0);
  });
});

/**
 * Graph integrity. ADR-0001 requires a dangling reference to be preserved and
 * *reported*, so it has to surface somewhere a user reads.
 */
describe("graph integrity drift", () => {
  const base = createEmptyArchitecture("graph", "Graph") as Architecture & {
    nodes?: Array<{ id: string }>;
    edges?: Array<Record<string, unknown>>;
  };

  it("reports a preserved dangling edge as critical", () => {
    const arch = { ...base, nodes: [{ id: "a" }], edges: [{ id: "e1", from: "a", to: "ghost", kind: "calls", dangling: true }] };
    const report = detectDrift(arch as Architecture, scan());

    const dangling = kinds(report, "dangling-edge");
    expect(dangling).toHaveLength(1);
    expect(dangling[0].severity).toBe("critical");
    expect(dangling[0].subject).toBe("e1");
  });

  it("reports a decision pointing at a node that no longer exists", () => {
    const arch = {
      ...base,
      nodes: [{ id: "a" }],
      edges: [],
      decisions: [
        {
          id: "dec-001",
          topic: "t",
          decision: "d",
          rationale: "r",
          alternatives: [{ name: "n", whyNot: "w" }],
          timestamp: "2026-05-05T00:00:00.000Z",
          relatedServices: ["deleted-service"],
        },
      ],
    };
    const report = detectDrift(arch as unknown as Architecture, scan());

    const orphan = kinds(report, "orphan-subject");
    expect(orphan).toHaveLength(1);
    expect(orphan[0].severity).toBe("critical");
    // And it is reported, not repaired: the rationale is still there.
    expect((arch as unknown as Architecture).decisions[0].rationale).toBe("r");
  });

  it("does not report an orphan subject that resolves", () => {
    const arch = {
      ...base,
      nodes: [{ id: "a" }],
      edges: [],
      decisions: [
        {
          id: "dec-001",
          topic: "t",
          decision: "d",
          rationale: "r",
          alternatives: [{ name: "n", whyNot: "w" }],
          timestamp: "2026-05-05T00:00:00.000Z",
          relatedServices: ["a"],
        },
      ],
    };
    expect(kinds(detectDrift(arch as unknown as Architecture, scan()), "orphan-subject")).toEqual([]);
  });
});