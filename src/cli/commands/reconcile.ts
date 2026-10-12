import { architecturePath } from "../../io/architecture-file.js";
import type { DerivationResult } from "../../analysis/derive.js";
import type { DriftReport } from "../../analysis/drift.js";
import { describeOutcome, reconcileOnce } from "../../analysis/watch.js";

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
  /**
   * Restrict the scan. Overrides `arkive.config.json`'s `include`.
   *
   * A narrowing is reported in `scanNotes` and in the coverage line, because a
   * scan that quietly covered half a repository would otherwise read as a scan
   * that covered all of it — which is the bug this command was rewritten to end.
   */
  include?: string[];
  /** Paths never walked. Overrides the config file's `exclude`. */
  exclude?: string[];
  /**
   * Print the derived graph's shape — node and edge counts, the per-language
   * breakdown, and every import site that did not resolve.
   *
   * On by default. A graph that is 40% derived must say so everywhere it is
   * displayed (ADR-0002:141-149), and the derivation summary is where a user
   * finds out which 60% they are not looking at.
   */
  graph?: boolean;
  /**
   * Persist the derived half and exit.
   *
   * `reconcile` is a diagnostic (ADR-0002:113-114). Off by default, and a test
   * asserts the default never rewrites the document — a command that quietly
   * rewrote a user's architecture file on every invocation is not a command
   * anyone can run from a git hook. `--apply` is the one-shot escape from
   * `arkive watch`, which is where continuous persistence belongs.
   */
  apply?: boolean;
}

export async function reconcileCommand(options: ReconcileOptions): Promise<void> {
  // One walk, five consumers. `reconcileOnce` runs the scan once and hands the
  // same result to the drift rules, the derivation, the orphan check and the
  // authored-drift check. Paying for the scan twice to print two views of the
  // same data is the kind of waste that makes people stop running the command.
  const outcome = reconcileOnce(options.dir, {
    ...(options.include !== undefined ? { include: options.include } : {}),
    ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
    apply: options.apply === true,
  });

  if (outcome.status === "absent") {
    process.stderr.write(
      `arkive/architecture.json not found at ${architecturePath(options.dir)}. ` +
        `Run \`arkive init\` first.\n`
    );
    process.exit(1);
  }

  if (outcome.status === "unreadable") {
    process.stderr.write(`Failed to read arkive/architecture.json: ${outcome.error}\n`);
    process.exit(1);
  }

  const { scan, derivation, drift: report } = outcome;

  const out = (line: string): void => {
    if (!options.quiet) process.stdout.write(line);
  };

  // The delta and the authored findings come first, always.
  //
  // They are the two things this command produces that a structural drift report
  // cannot: what derivation would change, and what a human's claim is no longer
  // supported by. Without `--apply` the delta is explicitly prospective, and it
  // is printed before the graph summary — which *is* a full redump — because the
  // delta is the part a reader acts on and the graph is context for it.
  out(describeOutcome(outcome, options.apply === true) + "\n");

  // "No drift detected" is a claim about the codebase, and this scan may never
  // have looked at the codebase. `report.conclusive` is the whole point of
  // running the scanner's coverage numbers: an empty warning list over a
  // partial view is not a clean bill of health, and saying so is the only
  // honest reading of it.
  //
  // An authored finding blocks this line too. "In sync" over a document that
  // asserts a human-verified service running technology the manifest does not
  // declare would be the same false assurance ADR-0002 was written against, one
  // layer up.
  if (report.conclusive && report.warnings.length === 0 && outcome.findings.length === 0) {
    out(`No drift detected. arkive/architecture.json is in sync.\n`);
    out(`  ${describeScan(scan)}. The graph it could derive is ${describeGraph(derivation)}.\n`);
    // Even on the clean path the scan has to say what it did and did not look
    // at. `--include src` produces a fully-conclusive scan over a *third* of a
    // repository, and "in sync" with no mention of that is the original bug one
    // step sideways: a claim the user acts on, about a narrower codebase than
    // they think they are agreeing about.
    out(describeScanNotes(derivation.notes));
    return;
  }

  if (report.warnings.length > 0) {
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
  }

  if (!report.conclusive && report.warnings.length === 0) {
    out(
      `arkive could not verify arkive/architecture.json against this codebase.\n` +
        `  ${describeScan(scan)}.\n` +
        `  This is NOT "in sync". Resolve the scan coverage before trusting it.\n`
    );
  }

  out(`Scan coverage: ${(scan.parseCoverage * 100).toFixed(1)}% ${describeScan(scan)}.\n`);

  if (options.graph !== false) {
    out(describeGraphReport(derivation, scan.filesScanned, scan.filesUnreadable, scan.filesTruncated));
  }

  // A critical finding must not be swallowed by the `|| true` in the post-commit
  // hook, so it gets a non-zero exit the hook can act on and CI can gate on.
  // Authored findings count too: a human-verified node the manifest contradicts
  // is the same class of defect as a dangling edge — the document asserts
  // something about the system that the system does not support.
  const authoredCriticals = outcome.findings.filter((f) => f.severity === "critical").length;
  if (report.summary.bySeverity.critical > 0 || authoredCriticals > 0) {
    process.exitCode = 1;
  }
}

/**
 * The scan's own notes, indented under whatever claim preceded them.
 *
 * Always printed, including on the "in sync" path. That path is the one a user
 * reads without reading, so it is exactly where a note about what was skipped
 * has to appear — otherwise `--include` is a way to turn any repository into a
 * green build.
 */
function describeScanNotes(notes: readonly string[]): string {
  if (notes.length === 0) return "";
  return `${notes.map((note) => `  note: ${note}\n`).join("")}`;
}

/**
 * The one-line scan description.
 *
 * Leads with `scanned N file(s)` because that phrasing predates derivation and
 * is what the honesty tests assert on — changing it for tidiness would break a
 * contract for no gain. The breakdown follows it, which is the part that is
 * actually new: "scanned 1 file" on its own cannot distinguish "read one file
 * and there was one" from "read one file and gave up on forty", and that
 * distinction is the entire subject of ADR-0002's coverage rule.
 */
function describeScan(scan: {
  filesScanned: number;
  filesUnreadable: number;
  filesTruncated: number;
  roots: string[];
}): string {
  return (
    `scanned ${scan.filesScanned} file(s) (${scan.filesUnreadable} unreadable, ` +
    `${scan.filesTruncated} not reached) across ${describeRoots(scan)}`
  );
}

function describeGraph(derivation: DerivationResult): string {
  const modules = derivation.nodes.filter((node) => node.kind === "module").length;
  const external = derivation.nodes.filter((node) => node.kind === "external").length;
  return (
    `${modules} module nodes, ${external} external nodes, ` +
    `${derivation.edges.length} imports edges at ${(derivation.coverage * 100).toFixed(1)}% coverage`
  );
}

/**
 * The graph's own coverage report.
 *
 * Kept separate from the drift report because they answer different questions:
 * drift asks "does the document match the code", this asks "how much of the code
 * is in the graph at all". Printing only the first is how a 40%-derived graph
 * gets read as a complete one.
 */
function describeGraphReport(
  derivation: DerivationResult,
  parsed: number,
  unreadable: number,
  truncated: number
): string {
  const lines: string[] = [];
  lines.push(`Derived graph: ${describeGraph(derivation)}`);
  lines.push(`  coverage: ${(derivation.coverage * 100).toFixed(1)}% (${parsed} parsed, ${unreadable} unreadable, ${truncated} not reached)`);

  const languages = Object.entries(derivation.byLanguage).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  if (languages.length > 0) {
    const detail = languages
      .map(
        ([id, stats]) =>
          `${id} ${stats.files} file(s)/${stats.imports} import(s)` +
          (stats.incomplete > 0 ? `/${stats.incomplete} unreadable` : "")
      )
      .join("; ");
    lines.push(`  languages: ${detail}`);
  }

  if (derivation.unresolved.length > 0) {
    lines.push(
      `  unresolved: ${derivation.unresolved.length} import site(s) name a module that is not on disk.`
    );
    // A sample, not all of them. A monorepo can produce thousands, and a report
    // nobody scrolls to the end of is a report nobody reads. The count above is
    // the honest part; these are the examples.
    for (const miss of derivation.unresolved.slice(0, 10)) {
      lines.push(`    ${miss.from}:${miss.line}  "${miss.specifier}"`);
    }
    if (derivation.unresolved.length > 10) {
      lines.push(`    … and ${derivation.unresolved.length - 10} more`);
    }
  }

  return `${lines.join("\n")}\n${describeScanNotes(derivation.notes)}`;
}

function describeRoots(scan: { roots: string[]; filesScanned: number }): string {
  if (scan.roots.length === 0) return "the repository root";
  return scan.roots.join(", ");
}

export type { DriftReport };