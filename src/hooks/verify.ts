import { existsSync } from "node:fs";
import { readArchitecture } from "../io/architecture-file.js";
import type { ArchitectureDocument } from "../io/architecture-file.js";
import { scanProject } from "../analysis/scanner.js";
import type { ScanResult } from "../analysis/scanner.js";
import { detectDrift } from "../analysis/drift.js";
import type { DriftKind, DriftReport, DriftWarning } from "../analysis/drift.js";
import { architecturePath } from "../io/architecture-file.js";

/**
 * The one place a hook decides whether the document agrees with the code.
 *
 * Three consumers — `pre-commit`, `stop`, `pre-compact` — and one definition of
 * "disagrees", because a gate and a report that compute it differently is the
 * kind of thing nobody notices until the gate blocks something the report called
 * clean.
 */

/**
 * Critical findings that describe **what arkive could not see**, not what is
 * wrong.
 *
 * This set is the reason the hook substrate has its own gate logic rather than
 * reusing `reconcile`'s exit code.
 *
 * `drift.ts` marks `incomplete-scan` and `missing-manifest` as `critical`, and
 * that is right: silence from a detector that did not look is not a clean bill
 * of health. But a `pre-commit` hook that blocks on them blocks commits because
 * the *scanner* is incomplete, not because anything is wrong with the document.
 * On this repository, for example, two non-JavaScript files out of 165 produce
 * `parseCoverage: 0.988`, which emits an `incomplete-scan` critical — and a gate
 * that honoured it would refuse every commit in a repository whose architecture
 * is in perfect order.
 *
 * So these two kinds are excluded from the gate and reported instead, and
 * everything else that is `critical` still blocks. `dangling-edge` and
 * `orphan-subject` are statements about the *document* — it asserts a
 * relationship that resolves to nothing — and they are as true under a partial
 * scan as under a complete one.
 */
export const COVERAGE_KINDS: ReadonlySet<DriftKind> = new Set<DriftKind>([
  "incomplete-scan",
  "missing-manifest",
]);

export type VerifyStatus =
  /** No document at this path. Not an error: arkive is not installed here. */
  | "absent"
  /** The document exists but could not be read or parsed. */
  | "unreadable"
  /** The document read, and the code was scanned. */
  | "verified";

export interface VerifyOutcome {
  status: VerifyStatus;
  /** Present when `status === "verified"`. */
  document: ArchitectureDocument | null;
  scan: ScanResult | null;
  drift: DriftReport | null;
  /** The read error, when `status === "unreadable"`. */
  error: string | null;
  /**
   * True when the drift report is not entitled to say "in sync".
   *
   * Mirrors `DriftReport.conclusive`, hoisted so a caller that only has an
   * outcome does not have to null-check its way to it.
   */
  inconclusive: boolean;
  /** Critical findings that describe a defect in the document. The gate's inputs. */
  blocking: DriftWarning[];
  /** Critical findings that describe a limit in arkive's own view. Reported, never blocking. */
  coverageGaps: DriftWarning[];
  elapsedMs: number;
}

const EMPTY_OUTCOME_BASE = {
  document: null,
  scan: null,
  drift: null,
  error: null,
} as const;

/** Split a report's criticals into "the document is wrong" and "arkive cannot see". */
export function partitionCritical(report: DriftReport): {
  blocking: DriftWarning[];
  coverageGaps: DriftWarning[];
} {
  const criticals = report.warnings.filter((warning) => warning.severity === "critical");
  return {
    blocking: criticals.filter((warning) => !COVERAGE_KINDS.has(warning.kind)),
    coverageGaps: criticals.filter((warning) => COVERAGE_KINDS.has(warning.kind)),
  };
}

/**
 * Read the document, scan the tree, detect drift.
 *
 * Never throws. Every failure mode — no document, unparseable JSON, a schema the
 * build does not recognise — becomes a {@link VerifyOutcome} the caller can act
 * on or ignore, because a hook that crashes has already lost the argument it
 * was making.
 */
export function verifyProject(projectDir: string): VerifyOutcome {
  const startedAt = Date.now();

  if (!existsSync(architecturePath(projectDir))) {
    return {
      ...EMPTY_OUTCOME_BASE,
      status: "absent",
      inconclusive: false,
      blocking: [],
      coverageGaps: [],
      elapsedMs: Date.now() - startedAt,
    };
  }

  const read = readArchitecture(projectDir);
  if (!read.success) {
    return {
      ...EMPTY_OUTCOME_BASE,
      status: "unreadable",
      error: read.error,
      inconclusive: true,
      blocking: [],
      coverageGaps: [],
      elapsedMs: Date.now() - startedAt,
    };
  }

  const scan = scanProject(projectDir);
  const drift = detectDrift(read.data, scan);
  const { blocking, coverageGaps } = partitionCritical(drift);

  return {
    status: "verified",
    document: read.data,
    scan,
    drift,
    error: null,
    inconclusive: !drift.conclusive,
    blocking,
    coverageGaps,
    elapsedMs: Date.now() - startedAt,
  };
}

/** One line per finding, in the shape a reader can act on or grep for. */
export function formatWarning(warning: DriftWarning): string {
  const arrow = warning.suggestion ? `\n    → ${warning.suggestion}` : "";
  return `  [${warning.severity}] (${warning.kind}) ${warning.message}${arrow}`;
}

/**
 * Render a coverage gap as a single sentence.
 *
 * Deliberately not phrased as a verdict in either direction. It says what was
 * not looked at, and stops there — "in sync" would be a lie and "out of date"
 * would be a different one.
 */
export function formatCoverageGap(warning: DriftWarning, scan: ScanResult | null): string {
  const coverage = scan ? ` (${(scan.parseCoverage * 100).toFixed(1)}% parsed)` : "";
  return `  (${warning.kind})${coverage}: ${warning.message}`;
}
