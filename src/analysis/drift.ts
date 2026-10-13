import type { Architecture } from "../schema/types.js";
import type { ScanResult } from "./scanner.js";
import { withinFilters } from "./scanner.js";

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
  | "dangling-edge"
  | "vanished-module"
  | "unresolved-import";

export interface DriftWarning {
  kind: DriftKind;
  severity: DriftSeverity;
  subject: string;
  message: string;
  suggestion: string;
}

/**
 * The summary half of a scan — the part `detectDrift` reasons over.
 *
 * Narrower than `ScanResult` on purpose. A scan also carries a file index,
 * per-file extraction and a byte count that no rule below reads, and depending
 * on all of it would make every future scan field a breaking change for the
 * whole analysis layer. The one optional member is documented at its use site.
 */
export type DriftScan = Pick<
  ScanResult,
  | "hasPackageJson"
  | "dependencies"
  | "imports"
  | "parseCoverage"
  | "filesScanned"
  | "filesUnreadable"
  | "filesTruncated"
  | "bytesScanned"
  | "roots"
  | "truncated"
  | "scanNotes"
> & {
  /**
   * Optional so a caller holding only the summary shape still type-checks. When
   * present it lets the module rules confirm a `module` node's `path` against
   * the filesystem; when absent they fall back to the tombstone alone.
   *
   * Directory nodes are checked against `directoryIndex`, never this one. A
   * directory path is never a member of `fileIndex`, so checking it there
   * reported every directory as deleted.
   */
  fileIndex?: ReadonlySet<string>;
  /** Every discovered directory, repo-relative. Required to check a `module:dir:` node. */
  directoryIndex?: ReadonlySet<string>;
  /**
   * The effective include/exclude the walk ran with (`ScanResult.filters`).
   * Optional so a caller holding only the summary shape still type-checks —
   * the vanished-module rule treats an absent filter set as "whole tree",
   * which is exactly what a filterless scan walked.
   */
  filters?: { include: readonly string[]; exclude: readonly string[] };
};

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

/**
 * Derivation output a rule needs and the document cannot supply.
 *
 * Narrower than `DerivationResult` for the same reason `DriftScan` is narrower
 * than `ScanResult`: `drift.ts` should not have to know how a graph was built.
 */
export interface DriftDerivation {
  unresolved: ReadonlyArray<{
    from: string;
    specifier: string;
    line: number;
    candidates: string[];
  }>;
}

export function detectDrift(
  architecture: Architecture,
  scan: DriftScan,
  derivation?: DriftDerivation
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
  //
  // `services` is read through the deprecated v1 view when it exists, and
  // through the graph when it does not. A pure v2 document has no `services`
  // until `project.ts` runs, and a rule that throws on one is a rule that
  // silently stops running on the shape the graph is stored in.
  if (scan.filesScanned > 0 && scan.parseCoverage >= 1) {
    const serviceTechs = new Set(
      readServiceTechnologies(architecture).map((tech) => tech.toLowerCase()).filter(Boolean)
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
  //
  // ADR-0002:105-107 deletes `confidence` outright. The rule is kept because
  // `src/io/v1-authoring.ts` still *carries* the field across a v1 migration, so
  // a document that arrived with a low number still has one — and a detector
  // that quietly stopped reading it would report fewer findings after an
  // upgrade, which is the opposite of what an upgrade should do.
  const legacyServices = (architecture as { services?: unknown }).services;
  for (const svc of Array.isArray(legacyServices) ? legacyServices : []) {
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
    nodes?: Array<{
      id: string;
      kind?: string;
      path?: string;
      deletedAt?: string;
      provenance?: { derived?: boolean; rule?: string; evidence?: string[] };
    }>;
  };

  // A derived `module` node the current run cannot reproduce. Issue 0005 §5
  // asks for exactly this to be `critical` rather than silence, and it is the
  // single most load-bearing check on this page: the old scanner reported "in
  // sync" on trees it had never opened, so a missing module is precisely the
  // class of fact that used to go unreported.
  //
  // It fires on exactly one signal: a LIVE node whose path is absent from the
  // file index. That is an unrecorded disappearance — the thing nobody has
  // looked at yet — and `reconcile --apply` is what records it, by tombstoning
  // the node with a visible report and a history entry.
  //
  // It deliberately does NOT fire on nodes that are already tombstoned. A
  // tombstone IS the record of a disappearance: firing `critical` on it every
  // run adds no information (nothing changed since the run that recorded it)
  // and manufactures a permanent alarm no deliberate action can clear —
  // removal is tombstone-only by design (ADR-0001:129-137), and re-removing a
  // tombstone is a no-op. A check that alarms forever trains the user to
  // ignore it, which is the same failure as reporting "in sync" on a tree it
  // never read (see the directory-index note below). The tombstone stays in
  // the document so decisions keep resolving to it; `whyDoesThisExist`
  // reports tombstoned claims as such.
  const moduleNodes = Array.isArray(asGraph.nodes) ? asGraph.nodes : [];
  // Paths the walk was told not to examine are out of scope, not vanished.
  // `arkive.config.json` `exclude` (and `--exclude`) removes a path from the
  // file and directory indexes by construction, so without this carve-out
  // every excluded file with a derived node reported itself deleted,
  // permanently, at `critical` severity — the same false-positive class as
  // the directory nodes above, wearing config clothes. Measured on this
  // repository (issue 0014 dogfood): excluding `bin` (a 2-line shim whose
  // only import points at gitignored build output) produced 2 standing
  // criticals for files that exist. The exclusion itself is reported in
  // `scanNotes` on every run, so skipping the rule loses nothing silent.
  const filters = scan.filters;
  for (const node of moduleNodes) {
    if (node.kind !== "module" || node.provenance?.derived !== true) continue;

    if (
      filters !== undefined &&
      typeof node.path === "string" &&
      node.path.length > 0 &&
      !withinFilters(node.path, filters.include, filters.exclude)
    ) {
      continue;
    }

    const tombstoned = node.deletedAt !== undefined;
    // A directory node's path is a directory; a file node's is a file. They
    // live in different indexes, and checking a directory against `fileIndex`
    // is always false - which made every directory node report itself
    // vanished, permanently, at `critical` severity. Measured on this
    // repository: 41 nodes, 41 false criticals, every one of them a directory
    // that `directoryIndex` confirmed still exists.
    //
    // That is the same failure class as the scanner reporting "in sync" on a
    // tree it never read: a check that manufactures false alarms is as
    // damaging as one that manufactures false confidence, because both train
    // the user to ignore it.
    const isDirNode = node.id.startsWith("module:dir:");
    const index = isDirNode ? scan.directoryIndex : scan.fileIndex;
    const missingOnDisk =
      index !== undefined &&
      typeof node.path === "string" &&
      node.path.length > 0 &&
      !index.has(node.path);

    // Only the unrecorded disappearance alarms. A tombstone is the recorded
    // state (see the rule header); re-alarming on it would make every
    // reviewed deletion a permanent critical no deliberate action clears.
    if (tombstoned || !missingOnDisk) continue;

    warnings.push({
      kind: "vanished-module",
      severity: "critical",
      subject: node.id,
      message:
        `Derived module "${node.path ?? node.id}" no longer exists. ` +
        `"${node.path}" is not in the scanned file index.` +
        ` It was derived by rule "${node.provenance?.rule ?? "(unknown)"}" from ` +
        `${(node.provenance?.evidence ?? []).slice(0, 3).join(", ") || "(no evidence)"}.`,
      suggestion:
        `If the module was deleted on purpose, run reconcile --apply to retire ` +
        `the node deliberately (tombstone, counted and reported — the alarm ` +
        `clears because the disappearance is then recorded). ` +
        `If it was moved, re-point the node at its new path. Do not do nothing: a graph ` +
        `that still contains a module nobody can open is not a graph of this repository.`,
    });
  }

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

  // An `imports` edge derivation could not resolve. Same class as a deleted
  // module and reported at the same severity, because from a reader's point of
  // view they are the same fact: source refers to something that is not there.
  //
  // Passed in rather than read off the document because it is a property of
  // *this* run, not of the stored graph — the document cannot know what the
  // scanner failed to resolve until the scanner has run.
  for (const miss of derivation?.unresolved ?? []) {
    warnings.push({
      kind: "unresolved-import",
      severity: "critical",
      subject: `${miss.from}:${miss.line}`,
      message:
        `${miss.from}:${miss.line} imports "${miss.specifier}", which resolves to no ` +
        `file in this repository. Tried: ${miss.candidates.slice(0, 4).join(", ") || "nothing"}.`,
      suggestion:
        `Restore the module, fix the import, or exclude the file. Until then the derived ` +
        `graph is incomplete — the edge was kept and flagged dangling rather than dropped.`,
    });
  }

  const decisions = Array.isArray(architecture.decisions)
    ? architecture.decisions
    : [];
  const nodeIds = new Set(
    Array.isArray(asGraph.nodes)
      ? asGraph.nodes.map((n) => n.id)
      : (Array.isArray(legacyServices) ? (legacyServices as Array<{ id: string }>).map((s) => s.id) : [])
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

/**
 * Service technologies, from whichever shape the document is in.
 *
 * The v1 view carries `technology` verbatim, so it is preferred. A pure v2
 * document has no `services[]` until `project.ts` projects one, and the graph's
 * `tech` field is the next best thing — better than throwing, and better than
 * returning an empty set, which would turn every declared dependency into an
 * `untracked-service` finding.
 */
function readServiceTechnologies(architecture: Architecture): string[] {
  const legacy = (architecture as { services?: Array<{ technology?: unknown }> }).services;
  if (Array.isArray(legacy)) {
    return legacy
      .map((service) => (typeof service.technology === "string" ? service.technology : ""))
      .filter((technology) => technology.length > 0);
  }
  const nodes = (architecture as unknown as { nodes?: Array<{ tech?: unknown }> }).nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((node) => (typeof node.tech === "string" ? node.tech : ""))
    .filter((tech) => tech.length > 0);
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
    "vanished-module": 0,
    "unresolved-import": 0,
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