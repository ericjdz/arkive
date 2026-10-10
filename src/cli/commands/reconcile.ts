import { existsSync } from "node:fs";
import { architecturePath, readArchitecture } from "../../io/architecture-file.js";
import { scanProject } from "../../analysis/scanner.js";
import { detectDrift } from "../../analysis/drift.js";
import type { DriftReport } from "../../analysis/drift.js";

export interface ReconcileOptions {
  dir: string;
  /**
   * Suppress output. Added because `src/cli/commands/hooks.ts:10` installs a
   * `post-commit` hook that runs `arkive reconcile --quiet`, and Commander
   * rejects an undeclared option — so the flag the shipped hook depends on did
   * not exist, and the hook had been printing its error to stderr on every
   * commit since it was written.
   */
  quiet?: boolean;
}

export async function reconcileCommand(options: ReconcileOptions): Promise<void> {
  const archPath = architecturePath(options.dir);
  if (!existsSync(archPath)) {
    process.stderr.write(
      `arkive/architecture.json not found at ${archPath}. Run \`arkive init\` first.\n`
    );
    process.exit(1);
  }

  const result = readArchitecture(options.dir);
  if (!result.success) {
    process.stderr.write(`Failed to read arkive/architecture.json: ${result.error}\n`);
    process.exit(1);
  }

  const scan = scanProject(options.dir);
  const report = detectDrift(result.data, scan);

  const out = (line: string): void => {
    if (!options.quiet) process.stdout.write(line);
  };

  // "No drift detected" is a claim about the codebase, and this scan may never
  // have looked at the codebase. `report.conclusive` is the whole point of
  // running the scanner's coverage numbers: an empty warning list over a
  // partial view is not a clean bill of health, and saying so is the only
  // honest reading of it.
  if (report.conclusive && report.warnings.length === 0) {
    out(`No drift detected. arkive/architecture.json is in sync.\n`);
    out(`  scanned ${scan.filesScanned} file(s) across ${describeRoots(scan)}.\n`);
    return;
  }

  if (!report.conclusive && report.warnings.length === 0) {
    out(
      `arkive could not verify arkive/architecture.json against this codebase.\n` +
        `  ${scan.filesScanned} file(s) parsed, ${scan.filesUnreadable} unreadable, ` +
        `${scan.filesTruncated} not reached, under ${describeRoots(scan)}.\n` +
        `  This is NOT "in sync". Resolve the scan coverage before trusting it.\n`
    );
    return;
  }

  out(`Found ${report.warnings.length} drift warning(s):\n\n`);
  for (const warning of report.warnings) {
    const icon = warning.severity === "critical" ? "🔴" : warning.severity === "warning" ? "🟡" : "🔵";
    // The kind is printed because it is the part a reader can act on or report:
    // the prose is a sentence, `incomplete-scan` is a search term.
    out(`${icon} [${warning.severity}] (${warning.kind}) ${warning.message}\n`);
    if (warning.suggestion) {
      out(`  → ${warning.suggestion}\n`);
    }
    out("\n");
  }

  out(
    `Scan coverage: ${(scan.parseCoverage * 100).toFixed(1)}% ` +
      `(${scan.filesScanned} parsed, ${scan.filesUnreadable} unreadable, ` +
      `${scan.filesTruncated} not reached) across ${describeRoots(scan)}.\n`
  );

  // A critical finding must not be swallowed by the `|| true` in the post-commit
  // hook, so it gets a non-zero exit the hook can act on and CI can gate on.
  if (report.summary.bySeverity.critical > 0) {
    process.exitCode = 1;
  }
}

function describeRoots(scan: { roots: string[]; filesScanned: number }): string {
  if (scan.roots.length === 0) return "the repository root";
  return scan.roots.join(", ");
}

export type { DriftReport };