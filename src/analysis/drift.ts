import type { Architecture } from "../schema/types.js";
import type { ScanResult } from "./scanner.js";

/**
 * Drift detection.
 *
 * Every rule here reasons from evidence. When the evidence is incomplete, a
 * rule that finds nothing is not reporting "no drift" — it is reporting
 * nothing, and the two are indistinguishable to whoever reads the output.
 *
 * That is why `incomplete-scan` is `critical` and why it exists at all. The
 * scanner used to assume a `src/` directory; a project without one scanned
 * zero files, every rule below found nothing to say, and `arkive reconcile`
 * printed "in sync". A drift detector that manufactures false confidence is
 * worse than no drift detector, because it is trusted *because* it is quiet.
 * (ADR-0002: "The scanner's `src` assumption becomes a correctness bug".)
 *
 * So the rules below run only when the scan can back them up, and
 * `incomplete-scan` is emitted whenever it cannot.
 */

export type DriftSeverity = "info" | "warning" | "critical";

export type DriftKind =
  | "undeclared-import"
  | "stale-stack"
  | "untracked-service"
  | "low-confidence"
  | "incomplete-scan"
  | "missing-manifest"
  | "orphan-subject"
  | "dangling-edge";

export interface DriftWarning {
  kind: DriftKind;
  severity: DriftSeverity;
  subject: string;
  message: string;
  suggestion: string;
}

export interface DriftReport {
  warnings: DriftWarning[];
  /**
   * Whether this report is entitled to say "in sync".
   *
   * `false` when the scan did not cover the project, when there is no
   * `package.json` to check imports against, or when any rule was suppressed
   * for lack of evidence. `reconcile` reads this rather than inferring
   * confidence from an empty warning list.
   */
  conclusive: boolean;
  summary: {
    total: number;
    bySeverity: Record<DriftSeverity, number>;
    byKind: Record<DriftKind, number>;
  };
}

const TOOLING_DENYLIST = new Set([
  "typescript",
  "tsup",
  "tsx",
  "vitest",
  "@types/node",
  "@vitest/ui",
  "eslint",
  "prettier",
  "handlebars",
  "commander",
  "zod",
  "@modelcontextprotocol/sdk",
]);

export function detectDrift(
  architecture: Architecture,
  scan: ScanResult
): DriftReport {
  const warnings: DriftWarning[] = [];
  let conclusive = true;

  // --- 0. can this scan back any claim at all? -----------------------------
  //
  // Emitted first, before every other rule, because it is the one that
  // determines what the absence of the others means.
  if (scan.parseCoverage < 1 || scan.truncated || scan.filesScanned === 0) {
    conclusive = false;
    warnings.push({
      kind: "incomplete-scan",
      severity: "critical",
      subject: scan.roots.length > 0 ? scan.roots.join(", ") : "(repository root)",
      message:
        `Static analysis covered ${(scan.parseCoverage * 100).toFixed(1)}% of the ` +
        `source files it found (${scan.filesScanned} parsed, ${scan.filesUnreadable} ` +
        `unreadable, ${scan.filesTruncated} not reached). ` +
        (scan.scanNotes.length > 0 ? scan.scanNotes.join("; ") + ". " : "") +
        `Import and stack rules below are running on a partial view; silence from ` +
        `them is not evidence that the document matches the code.`,
      suggestion:
        `Run the scan on a tree arkive can read (check .gitignore and the ` +
        `node_modules/dist/build/vendor/.git skips), or treat this as unresolved ` +
        `rather than in sync.`,
    });
  }

  if (!scan.hasPackageJson) {
    conclusive = false;
    warnings.push({
      kind: "missing-manifest",
      severity: "critical",
      subject: "package.json",
      message:
        `No package.json at the project root, so no dependency can be declared or ` +
        `undeclared. ${scan.filesScanned} source file(s) were scanned and nothing ` +
        `could be checked against them.`,
      suggestion:
        `If this project genuinely has no package.json, arkive cannot verify it. ` +
        `Do not read the absence of import warnings as agreement.`,
    });
  }

  if (!scan.hasPackageJson) {
    // Every remaining rule needs the manifest as its reference set.
    return finalize(warnings, conclusive);
  }

  const deps = new Set(scan.dependencies);

  // --- 1. imports not declared in package.json ------------------------------
  if (scan.filesScanned > 0 && scan.parseCoverage >= 1) {
    for (const imp of scan.imports) {
      if (deps.has(imp)) continue;
      warnings.push({
        kind: "undeclared-import",
        severity: "warning",
        subject: imp,
        message: `Source imports "${imp}" but it is not in package.json dependencies.`,
        suggestion: `Run \`npm install ${imp}\` or remove the import.`,
      });
    }
  }

  // --- 2. stack entries with no matching dependency -------------------------
  const stackEntries = [
    ...architecture.stack.framework,
    ...architecture.stack.database,
    ...architecture.stack.runtime,
  ];
  for (const entry of stackEntries) {
    if (!matchesAnyDep(entry, deps)) {
      warnings.push({
        kind: "stale-stack",
        severity: "warning",
        subject: entry,
        message: `arkive/architecture.json lists "${entry}" in stack, but no matching dependency found in package.json.`,
        suggestion: `Either install the dependency or remove "${entry}" from architecture.stack.`,
      });
    }
  }

  // --- 3. imports that map to no tracked service ----------------------------
  if (scan.filesScanned > 0 && scan.parseCoverage >= 1) {
    const serviceTechs = new Set(
      architecture.services.map((s) => (s.technology ?? "").toLowerCase()).filter(Boolean)
    );
    for (const imp of scan.imports) {
      if (TOOLING_DENYLIST.has(imp)) continue;
      if (!deps.has(imp)) continue;
      if (mapsToService(imp, serviceTechs)) continue;
      warnings.push({
        kind: "untracked-service",
        severity: "info",
        subject: imp,
        message: `Imported package "${imp}" does not correspond to any service.technology in arkive/architecture.json.`,
        suggestion: `If "${imp}" introduces a new service or significant capability, add or update a service entry.`,
      });
    }
  }

  // --- 4. low-confidence services -------------------------------------------
  for (const svc of architecture.services) {
    const conf = (svc as { confidence?: unknown }).confidence;
    if (typeof conf === "number" && conf < 0.6) {
      warnings.push({
        kind: "low-confidence",
        severity: "warning",
        subject: svc.id,
        message: `Service "${svc.name}" has low confidence (${conf}). Source: ${(svc as { source?: string }).source ?? "unknown"}.`,
        suggestion: `Verify this service exists and is correctly described. Set confidence to 1.0 and source to "human-verified" after review.`,
      });
    }
  }

  // --- 5. graph integrity ----------------------------------------------------
  //
  // ADR-0001:141-149 requires a dangling reference to be reported, never
  // deleted, so it is a `critical` finding here rather than something `reconcile`
  // may quietly drop: the document currently asserts a relationship that
  // resolves to nothing, and only a human can say whether to fix or remove it.
  const asGraph = architecture as unknown as {
    edges?: Array<Record<string, unknown>>;
    nodes?: Array<{ id: string }>;
  };

  const dangling = Array.isArray(asGraph.edges)
    ? asGraph.edges.filter((edge) => edge?.dangling === true)
    : [];
  for (const edge of dangling) {
    warnings.push({
      kind: "dangling-edge",
      severity: "critical",
      subject: String(edge.id ?? `${edge.from}->${edge.to}`),
      message:
        `Edge "${edge.id}" points at "${edge.from}->${edge.to}", which does not resolve ` +
        `to a node. It was preserved rather than dropped on purpose (ADR-0001:141-145) — ` +
        `dropping it silently is the 62066bc failure class.`,
      suggestion:
        `Recreate the missing node, or delete the edge. It stays until a human decides.`,
    });
  }

  const decisions = Array.isArray(architecture.decisions)
    ? architecture.decisions
    : [];
  const nodeIds = new Set(
    Array.isArray(asGraph.nodes)
      ? asGraph.nodes.map((n) => n.id)
      : architecture.services.map((s) => s.id)
  );
  for (const decision of decisions) {
    const related = (decision as { relatedServices?: unknown }).relatedServices;
    if (!Array.isArray(related)) continue;
    for (const ref of related) {
      if (typeof ref !== "string" || nodeIds.has(ref)) continue;
      warnings.push({
        kind: "orphan-subject",
        severity: "critical",
        subject: `${decision.id}:${ref}`,
        message:
          `Decision "${decision.id}" points at "${ref}", which does not exist. The ` +
          `decision is intact and nothing has been deleted — but the reasoning it ` +
          `records is no longer attached to anything.`,
        suggestion:
          `Restore the node, or re-point the decision at what it actually explains.`,
      });
    }
  }

  return finalize(warnings, conclusive);
}

function matchesAnyDep(stackEntry: string, deps: Set<string>): boolean {
  const normalized = stackEntry.toLowerCase().replace(/[.\s]/g, "");
  for (const dep of deps) {
    const depNorm = dep.toLowerCase().replace(/[.\-/@]/g, "");
    if (depNorm.includes(normalized) || normalized.includes(depNorm)) {
      return true;
    }
  }
  return false;
}

function mapsToService(imp: string, serviceTechs: Set<string>): boolean {
  const norm = imp.toLowerCase().replace(/[.\-/@]/g, "");
  for (const tech of serviceTechs) {
    const techNorm = tech.replace(/[.\s\-]/g, "");
    if (techNorm.includes(norm) || norm.includes(techNorm)) {
      return true;
    }
  }
  return false;
}

function finalize(warnings: DriftWarning[], conclusive: boolean): DriftReport {
  const bySeverity: Record<DriftSeverity, number> = {
    info: 0,
    warning: 0,
    critical: 0,
  };
  const byKind: Record<DriftKind, number> = {
    "undeclared-import": 0,
    "stale-stack": 0,
    "untracked-service": 0,
    "low-confidence": 0,
    "incomplete-scan": 0,
    "missing-manifest": 0,
    "orphan-subject": 0,
    "dangling-edge": 0,
  };
  for (const warning of warnings) {
    bySeverity[warning.severity] += 1;
    byKind[warning.kind] += 1;
  }
  return {
    warnings,
    conclusive,
    summary: {
      total: warnings.length,
      bySeverity,
      byKind,
    },
  };
}