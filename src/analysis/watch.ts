import { existsSync } from "node:fs";
import {
  architecturePath,
  readArchitecture,
  writeArchitecture,
} from "../io/architecture-file.js";
import type { ArchitectureDocument, ArchitectureWriteInput } from "../io/architecture-file.js";
import { scanProject } from "./scanner.js";
import type { ScanOptions, ScanResult } from "./scanner.js";
import { deriveFromScan, mergeDerived, isHumanVerified } from "./derive.js";
import type { AuthoredOrphan, DerivationResult, MergeResult } from "./derive.js";
import { detectDrift } from "./drift.js";
import type { DriftReport } from "./drift.js";
import { CURRENT_SCHEMA_VERSION } from "../schema/graph.js";
import type { ArchitectureDocumentV2, GraphNode } from "../schema/graph.js";

/**
 * Continuous reconciliation — `docs/issues/0007-continuous-reconciliation.md`.
 *
 * ADR-0002:110-125 makes the claim this file implements: "The derived half is
 * regenerated on every scan, so it cannot drift. There is nothing to
 * reconcile." Everything below is the machinery that makes that claim safe to
 * run on every change, and it is small on purpose.
 *
 * ## Why this is not a watcher with a cache
 *
 * The obvious design for "scan on change" is a daemon holding a memoised scan
 * and invalidating it on `fs.watch` events. Two things rule it out:
 *
 * 1. **Issue 0011 measured `pre-compact` at 2229ms against a 200ms budget and
 *    declined to cache across processes**, on the reasoning that a cache keyed
 *    on max-mtime still requires the walk. That reasoning applies here too, and
 *    `watch` is where it belongs: the watch loop holds the *previous
 *    derivation* so it can print a delta, which is not the same thing as a
 *    cache. Every cycle re-walks, re-reads, and re-derives from scratch. The
 *    only thing carried between cycles is the answer to "what did this cycle
 *    change", which is what makes the output a delta instead of a wall.
 * 2. A cache is an invalidation bug waiting to happen. `pre-compact` failing
 *    open on a stale cache would inject a graph that does not exist into the
 *    one context window that cannot be re-read. This file has no cache, so it
 *    has no invalidation surface, and `verifyProject` (which the hooks call) is
 *    untouched.
 *
 * ## What persists, and what does not
 *
 * **Only `watch` writes, and only with `--apply` or the default watch loop.**
 * `reconcile` stays a diagnostic — ADR-0002:113-114 keeps it as "a one-shot
 * check", and `tests/analysis/derive-cli.test.ts` asserts it never rewrites the
 * document. The persistence decision lives here, in one place, behind one
 * function, rather than being smeared across a `--write` flag on three
 * commands.
 *
 * ## The guarantee this file exists to keep
 *
 * An authored node survives any number of cycles unchanged. `mergeDerived`
 * enforces it at the merge; {@link reconcileOnce} enforces it at the write, by
 * refusing to persist anything when the merge changed nothing. Cycle 2..N on a
 * quiet tree produce a byte-identical document, which is a stronger property
 * than "nothing was clobbered" — a reconcile that rewrote timestamps every tick
 * would pass the first test and still be unusable.
 */

/** Severity of an authored-drift finding. Mirrors `DriftSeverity`. */
export type FindingSeverity = "critical" | "warning";

/**
 * A signal about the **authored** half.
 *
 * The derived half needs none — it cannot drift, because it is regenerated. So
 * every finding this file can produce is about a human claim the code no longer
 * supports, or about an authored node derivation cannot corroborate. A derived
 * node that moved is not a finding. It is Tuesday.
 */
export interface AuthoredFinding {
  kind: "authored-unsupported" | "orphaned-authored";
  severity: FindingSeverity;
  /** The node id. Findings name their subject; a reader must never have to
   *  reverse-engineer which node a sentence is about. */
  subject: string;
  message: string;
  suggestion: string;
  /** `true` when a human put their name on the node. */
  humanVerified: boolean;
}

/**
 * What one cycle changed.
 *
 * Numbers, not lists, for the counts a reader wants ("3 nodes added"). The
 * samples exist because a count with no example is a claim nobody can check, and
 * `reconcile` already learned this from its unresolved-import report.
 */
export interface ReconcileDelta {
  /** Nodes this cycle introduced. */
  addedNodes: string[];
  /** Nodes tombstoned this cycle. */
  removedNodes: string[];
  /** Edges introduced or dropped. */
  addedEdges: number;
  droppedEdges: number;
  /** Derived elements refreshed in place. Not a finding; a count of normal work. */
  replaced: number;
  /** Authored elements a derivation would have replaced and did not. */
  preservedAuthored: number;
  /** `true` when the merge produced a document identical to the stored one. */
  noChange: boolean;
}

/** Scan configuration only. `dir` is a parameter of {@link reconcileOnce}. */
export interface ReconcileOptions extends ScanOptions {
  /** Overrides `arkive.config.json`. CLI flags land here. */
  include?: string[];
  exclude?: string[];
  /** A different registry, for a test that proves one-language projects. */
  registry?: ScanOptions["registry"];
  /** Also write the derived half. `false` by default — this is the diagnostic path. */
  apply?: boolean;
}

export type ReconcileOutcome =
  | {
      status: "reconciled";
      delta: ReconcileDelta;
      merge: MergeResult;
      derivation: DerivationResult;
      scan: ScanResult;
      findings: AuthoredFinding[];
      drift: DriftReport;
      document: ArchitectureDocument;
      /** `false` when `apply` was not requested, or when there was nothing to write. */
      written: boolean;
      /** Set when a write was attempted and failed. Never swallowed. */
      writeError: string | null;
      elapsedMs: number;
    }
  | { status: "absent" }
  | { status: "unreadable"; error: string };

/**
 * Run the whole cycle once, in memory, and optionally persist the derived half.
 *
 * One walk, four consumers: the derivation, the drift report, the orphan check,
 * and the authored-drift check. Paying for the scan twice to print two views of
 * the same data is the waste `reconcile.ts` already learned not to do.
 *
 * Never throws. A reconciliation engine that crashes leaves the document exactly
 * as it found it, which is the only safe failure mode for something that runs on
 * every change.
 */
export function reconcileOnce(
  dir: string,
  options: ReconcileOptions = {}
): ReconcileOutcome {
  const startedAt = Date.now();

  if (!existsSync(architecturePath(dir))) return { status: "absent" };

  const read = readArchitecture(dir);
  if (!read.success) return { status: "unreadable", error: read.error };

  const scan = scanProject(dir, options);
  const derivation = deriveFromScan(scan, options);
  const merge = mergeDerived(read.data, derivation);
  const findings = authoredFindings(read.data, scan, merge);
  const drift = detectDrift(read.data, scan, derivation);

  const delta = toDelta(merge);
  const shouldWrite = options.apply === true && !delta.noChange;

  let written = false;
  let writeError: string | null = null;

  if (shouldWrite) {
    // Built as a **pure v2 graph** — `services` / `connections` / `version`
    // deliberately absent.
    //
    // This is the load-bearing part of the write. `readArchitecture` attaches the
    // deprecated v1 view, and `writeArchitecture` folds a v1 view back onto the
    // graph before persisting. Handing it that view would let a projection
    // recomputed *from the graph* vote on the graph — a derived view editing its
    // own source, which is the "hand-editable derived field is a drift source"
    // failure `foldV1ViewOntoGraph` is built to prevent. Derivation writes the
    // graph; the projection is regenerated from it on the way out and never
    // contributes an edit.
    //
    // Everything else the document holds — `project`, `stack`, `decisions`,
    // `dataFlows`, `history`, and any key a hand added that this build does not
    // recognise — is carried across untouched, because `readArchitecture` already
    // merged the schema's view into the parsed value (ADR-0006 §3).
    const payload: Record<string, unknown> = {
      ...(read.data as unknown as Record<string, unknown>),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      nodes: merge.nodes,
      edges: merge.edges,
      history: appendDerivationHistory(read.data, merge),
    };
    delete payload.services;
    delete payload.connections;
    delete payload.version;
    delete payload.warnings;

    // Persisted through `writeArchitecture`, not a bespoke writer, so watch mode
    // gets the same atomic write, the same history cap, the same snapshot dedup
    // and the same projection every other write path gets. A second write path
    // is a second set of bugs.
    const result = writeArchitecture(dir, payload as ArchitectureWriteInput);
    if (result.success) {
      written = true;
      // Re-read so `document` is the persisted truth, not the in-memory merge.
      // A caller reporting on a document that was never written is the
      // difference between a report and a guess.
      const after = readArchitecture(dir);
      if (after.success) {
        return {
          status: "reconciled",
          delta,
          merge,
          derivation,
          scan,
          findings,
          drift,
          document: after.data,
          written: true,
          writeError: null,
          elapsedMs: Date.now() - startedAt,
        };
      }
    } else {
      writeError = result.error;
    }
  }

  return {
    status: "reconciled",
    delta,
    merge,
    derivation,
    scan,
    findings,
    drift,
    document: read.data,
    written,
    writeError,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Record what a reconciliation changed, and only what is not obvious.
 *
 * **Removals are recorded; additions are not.** ADR-0001:129-137 asks for the
 * first — "a silent tombstone is a tombstone nobody cleans up" — and the second
 * is noise: a watcher that appends a history entry every time someone creates a
 * file fills `history[]` to its 50-entry cap within an afternoon and sets a
 * sticky `historyTruncated` flag that a human then has to clear by hand. What a
 * reader can see in `git diff` does not belong in the JSON file.
 *
 * One entry per cycle that changed something, not one per element: fifty
 * tombstoned modules is one event.
 */
function appendDerivationHistory(
  document: ArchitectureDocument,
  merge: MergeResult
): ArchitectureDocumentV2["history"] {
  if (merge.removedNodes.length === 0) return document.history;

  const now = new Date().toISOString();
  const summary =
    merge.removedNodes.length === 1
      ? `Derived refresh tombstoned ${merge.removedNodes[0]}: this scan could not ` +
        `reproduce it. Authored nodes are never removed by derivation.`
      : `Derived refresh tombstoned ${merge.removedNodes.length} nodes this scan could ` +
        `not reproduce: ${merge.removedNodes.slice(0, 5).join(", ")}` +
        (merge.removedNodes.length > 5 ? `, and ${merge.removedNodes.length - 5} more` : "") +
        `. Authored nodes are never removed by derivation.`;

  return [...document.history, { timestamp: now, action: "derive_refresh", summary }];
}

function toDelta(merge: MergeResult): ReconcileDelta {
  return {
    addedNodes: merge.addedNodes,
    removedNodes: merge.removedNodes,
    addedEdges: merge.addedEdges,
    droppedEdges: merge.droppedEdges,
    replaced: merge.replaced,
    preservedAuthored: merge.preservedAuthored,
    // A merge that added nothing, removed nothing and dropped nothing is a
    // no-op. Deriving 231 nodes and finding 231 nodes already there is the
    // steady state, and a `watch` that wrote on every cycle of it would dirty
    // the tree forever.
    noChange:
      merge.addedNodes.length === 0 &&
      merge.removedNodes.length === 0 &&
      merge.addedEdges === 0 &&
      merge.droppedEdges === 0,
  };
}

/**
 * The authored-drift check: an authored claim the code no longer supports.
 *
 * ### The rule
 *
 * For every **human-verified** authored node carrying a `tech`, ask whether
 * `package.json` still declares it. A `human-verified` service whose technology
 * has disappeared from `package.json` is a real problem, and it is `critical`,
 * because it is the exact failure ADR-0002 is built to end: a document asserting
 * a fact about the system that the system contradicts.
 *
 * ### Why only human-verified nodes
 *
 * An agent-authored node with the same problem is a `warning`, not a `critical`.
 * The difference is who is wrong. An agent recorded a guess; a human recorded a
 * judgement they will be asked to defend, and reporting a human's unsupported
 * claim at the same volume as a model's is how a report gets filtered by
 * severity and then ignored entirely.
 *
 * ### Why the manifest and not the import graph
 *
 * `tech` is a *declared* technology, not an imported symbol. `package.json` is
 * where a project declares one, so that is the only file whose contents can
 * contradict the claim. Checking imports instead would fire on a project that
 * vendors a database client, and a rule that fires on vendored code is a rule
 * nobody reads (ADR-0002:150-152).
 *
 * ### Matching
 *
 * Normalised containment, in both directions, the same rule `drift.ts` applies
 * to `stack`. `pg` matches `Postgres`, `Postgres` matches `pg`. It is a
 * heuristic and it is honest about being one: a technology named in prose
 * ("Postgres via a managed connection pooler") will not match, and that is a
 * miss rather than a false alarm. A false alarm on every `critical` in this
 * report would be worse than the miss, and the repository's own
 * `docs/adr/0002` says so in as many words.
 *
 * ### Suppression
 *
 * Suppressed entirely when there is no `package.json`, or when the scan did not
 * cover the project. Same rule as every other import-level check: a rule that
 * fires on half the files is worse than one that does not fire. The suppression
 * is reported, never silent.
 */
function authoredFindings(
  document: ArchitectureDocument,
  scan: ScanResult,
  merge: MergeResult
): AuthoredFinding[] {
  const findings: AuthoredFinding[] = [];

  if (canJudgeManifest(scan)) {
    const deps = scan.dependencies.map((dep) => normaliseTech(dep));
    for (const node of document.nodes) {
      if (node.provenance.derived) continue;
      if (node.deletedAt !== undefined) continue;
      if (typeof node.tech !== "string" || node.tech.trim() === "") continue;
      if (deps.some((dep) => techMatches(dep, normaliseTech(node.tech as string)))) continue;

      findings.push({
        kind: "authored-unsupported",
        severity: isHumanVerified(node) ? "critical" : "warning",
        subject: node.id,
        humanVerified: isHumanVerified(node),
        message:
          `Node "${node.id}"${node.name !== node.id ? ` (${node.name})` : ""} was ` +
          `verified by a human and names technology "${node.tech}", which is not ` +
          `declared in package.json. The document asserts a fact about this system ` +
          `that the manifest contradicts.`,
        suggestion:
          `If the technology is still used, add it to package.json. If it was ` +
          `replaced, update or remove the node — do not leave the record asserting ` +
          `something the project no longer depends on.`,
      });
    }
  }

  for (const orphan of merge.orphanedAuthored) {
    findings.push(orphanFinding(orphan));
  }

  return findings;
}

/** One orphan, phrased as a question. Never as a deletion. */
function orphanFinding(orphan: AuthoredOrphan): AuthoredFinding {
  const who = orphan.humanVerified ? "A human verified" : "Someone recorded";
  const what =
    orphan.kind === "external"
      ? `the external "${orphan.id.slice("external:".length)}"`
      : `the file "${orphan.path ?? orphan.id}"`;

  return {
    kind: "orphaned-authored",
    severity: orphan.humanVerified ? "critical" : "warning",
    subject: orphan.id,
    humanVerified: orphan.humanVerified,
    message:
      `${who} node "${orphan.id}", and this scan did not derive ${what}. ` +
      `The node has been kept exactly as it was — nothing was removed — but nothing ` +
      `in the repository corroborates it any more.`,
    suggestion:
      `If it moved, re-point the node at its new location. If it is gone, remove it ` +
      `deliberately so the decisions that referenced it can be re-read in the light ` +
      `of its absence. Arkive will not do this for you: a recorded node somebody ` +
      `verified is not arkive's to delete.`,
  };
}

/**
 * Can the manifest be asked a question at all?
 *
 * Two ways to answer no, both of which mean "the absence of a finding is not a
 * verdict": there is no manifest, or the scan did not reach the project.
 */
function canJudgeManifest(scan: ScanResult): boolean {
  return (
    scan.hasPackageJson &&
    scan.parseCoverage >= 1 &&
    !scan.truncated &&
    scan.filesScanned > 0
  );
}

/** Strip punctuation and case, so `Postgres` and `post-gres` are comparable. */
function normaliseTech(value: string): string {
  return value.toLowerCase().replace(/[.\s\-/_@:]/g, "");
}

/**
 * Does a declared dependency satisfy a claimed technology?
 *
 * Containment either way, because neither side knows what the other meant:
 * `@types/pg` should satisfy `pg`, and `pg` should satisfy `Postgres driver`.
 *
 * ### The length guard is per-direction, not global
 *
 * This was wrong at first and a real `critical` was the symptom: `pg` — one of
 * the most common package names there is — was reported as unsupported in a
 * project that declared it. The cause was guarding *both* sides at three
 * characters, which threw away the exact match `"pg" === "pg"`.
 *
 * The asymmetry is real, and the fix follows it:
 *
 * - **`dependency.includes(tech)`** — `tech` is the needle, so a short needle
 *   is dangerous: `"js"` is a substring of `"expressjs"`, `"typejs"`, and a
 *   hundred others. Guarded at three characters. This is a *contains* claim and
 *   needs the evidence to be there.
 * - **`tech.includes(dependency)`** — `dependency` is the needle, and a short
 *   one is the strongest possible evidence rather than the weakest. `"Postgres
 *   driver over pg"` contains `pg`; that is not a coincidence, that is the
 *   package being named. Not guarded.
 *
 * The rule this encodes: a substring match is evidence when the *needle* is
 * specific, and noise when it is not. Length is a proxy for specificity, and it
 * is only a proxy on the side where the needle is doing the work.
 */
function techMatches(dependency: string, tech: string): boolean {
  if (tech.length >= 3 && dependency.includes(tech)) return true;
  return tech.includes(dependency);
}

// --- the delta, as prose ------------------------------------------------------

/**
 * One line, the shape a reader acts on.
 *
 * "3 nodes added, 1 human-verified node no longer supported" — not a redump of
 * the graph. Issue 0007 §5 asks for exactly this and the alternative is a wall
 * nobody scrolls past. The counts that are zero are omitted, because
 * "0 nodes removed" is noise in a sentence whose job is to say what happened.
 *
 * `applied` switches the verb. A diagnostic that says "3 nodes added" over a
 * document it did not touch is asserting something false, and the reader who
 * believes it will assume the graph is current. `reconcile` without `--apply`
 * says "would add", which is true in both directions: it describes a merge that
 * was computed and discarded.
 */
export function formatDelta(
  delta: ReconcileDelta,
  findings: AuthoredFinding[],
  applied = false
): string {
  const verb = applied ? "" : "would ";
  const parts: string[] = [];

  if (delta.addedNodes.length > 0) {
    parts.push(`${delta.addedNodes.length} node${delta.addedNodes.length === 1 ? "" : "s"} added`);
  }
  if (delta.removedNodes.length > 0) {
    parts.push(
      `${delta.removedNodes.length} node${delta.removedNodes.length === 1 ? "" : "s"} removed`
    );
  }
  if (delta.addedEdges > 0) {
    parts.push(`${delta.addedEdges} edge${delta.addedEdges === 1 ? "" : "s"} added`);
  }
  if (delta.droppedEdges > 0) {
    parts.push(`${delta.droppedEdges} edge${delta.droppedEdges === 1 ? "" : "s"} dropped`);
  }

  const sentence = parts.join(", ");
  const criticals = findings.filter((finding) => finding.severity === "critical");
  const warnings = findings.filter((finding) => finding.severity === "warning");

  // Findings are stated independently of the applied flag. Whether the document
  // was written has no bearing on whether a human's claim is unsupported, and a
  // finding that appears only in one mode would be a finding nobody sees.
  const tail: string[] = [];
  if (criticals.length > 0) {
    tail.push(
      `${criticals.length} human-verified ${criticals.length === 1 ? "claim" : "claims"} ` +
        `no longer supported by the code`
    );
  }
  if (warnings.length > 0) {
    tail.push(`${warnings.length} authored ${warnings.length === 1 ? "claim" : "claims"} unconfirmed`);
  }

  if (sentence.length === 0) {
    return tail.length === 0
      ? "No change. The derived half is already current."
      : `${capitalise(tail.join(", and "))}.`;
  }

  // Lower case the count-led head and capitalise the whole thing. `capitalise`
  // is applied to the finished sentence rather than to `verb + sentence`,
  // because capitalising "would" turns the conditional into an assertion —
  // "Would 4 nodes added" reads like it happened.
  const head = capitalise(`${verb}${sentence}`);
  return tail.length === 0 ? `${head}.` : `${head}; ${tail.join(", and ")}.`;
}

function capitalise(text: string): string {
  return text.length === 0 ? text : `${text[0].toUpperCase()}${text.slice(1)}`;
}

/** Findings, one per block, the same shape the drift report uses. */
export function formatFindings(findings: readonly AuthoredFinding[]): string {
  if (findings.length === 0) return "";
  const lines: string[] = [];
  for (const finding of findings) {
    const icon = finding.severity === "critical" ? "🔴" : "🟡";
    lines.push(`${icon} [${finding.severity}] (${finding.kind}) ${finding.subject}: ${finding.message}`);
    lines.push(`  → ${finding.suggestion}`);
    lines.push("");
  }
  return lines.join("\n");
}

// --- the watch loop -----------------------------------------------------------

export interface WatchOptions extends ReconcileOptions {
  /** The project root. */
  dir: string;
  /** Milliseconds between cycles. */
  intervalMs?: number;
  /** Called after every cycle that changed something. */
  onCycle?: (outcome: Extract<ReconcileOutcome, { status: "reconciled" }>) => void;
  /** Called on any failure that is not a normal outcome. */
  onError?: (error: unknown) => void;
  /** Stop after this many cycles. For tests; unbounded in normal use. */
  maxCycles?: number;
  /** Injected clock, so a test does not have to sleep. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export const DEFAULT_WATCH_INTERVAL_MS = 1000;

/**
 * Watch the tree, reconcile on a timer, report the delta.
 *
 * ### A timer, not `fs.watch`
 *
 * `fs.watch` is recursive on macOS and Windows and **not** on Linux without a
 * flag, and it does not fire for a file replaced by rename on every platform.
 * A cross-platform tool that silently watches nothing on a third of its
 * audience is worse than one that polls: this is a documentation tool whose
 * whole value is that its record is true, and a watcher that quietly misses an
 * edit produces a graph that is confidently wrong.
 *
 * So it polls. The cost is a walk per cycle — the same walk `pre-compact`
 * already pays and the same one issue 0011 declined to cache around — and the
 * interval is a flag rather than a constant so a monorepo can widen it.
 *
 * ### What it does on each cycle
 *
 * Reconcile with `apply` forced on, so the derived half is always current, and
 * emit only when something changed. The steady state on a quiet tree is
 * silence: a process that prints on every tick is a process whose output is
 * background noise, and the one moment that matters is the moment the delta is
 * non-empty.
 */
export function startWatch(options: WatchOptions): { stop: () => void } {
  const interval = options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  const schedule = options.setTimeoutFn ?? setTimeout;
  const unschedule = options.clearTimeoutFn ?? clearTimeout;
  const apply: ReconcileOptions = { ...options, apply: true };

  let stopped = false;
  let cycles = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = (): void => {
    if (stopped) return;
    cycles += 1;
    try {
      const outcome = reconcileOnce(options.dir, apply);
      // Only a real change is news. `absent` is silent: a hook that fires in a
      // directory arkive was never installed into should be invisible, and the
      // same courtesy extends to a watcher nobody asked to be quiet.
      if (outcome.status === "reconciled" && !outcome.delta.noChange) {
        options.onCycle?.(outcome);
      }
    } catch (error) {
      options.onError?.(error);
    }
    if (options.maxCycles !== undefined && cycles >= options.maxCycles) {
      stopped = true;
      return;
    }
    timer = schedule(tick, interval);
  };

  timer = schedule(tick, 0);

  return {
    stop: (): void => {
      stopped = true;
      if (timer !== undefined) unschedule(timer);
    },
  };
}

// --- the report a hook or a CLI prints ----------------------------------------

/**
 * Everything a caller needs to know about one cycle, in one string.
 *
 * `applied` decides whether the delta is stated as a fact or as a proposal. This
 * distinction is the whole reason `reconcile` can show a delta without writing:
 * "3 nodes added" over a document that was not touched is a lie, and a reader
 * who acts on it — by assuming the graph is current — is exactly the failure this
 * product exists to prevent. So the prospective form says `would add`, and only
 * `watch` (or `reconcile --apply`) ever prints the past tense.
 */
export function describeOutcome(
  outcome: Extract<ReconcileOutcome, { status: "reconciled" }>,
  applied: boolean
): string {
  const lines: string[] = [describeDelta(outcome.delta, outcome.findings, applied)];
  const findings = formatFindings(outcome.findings);
  if (findings !== "") lines.push(findings.trimEnd());
  if (outcome.writeError !== null) {
    lines.push(`Could not persist the derived half: ${outcome.writeError}`);
  }
  return lines.join("\n");
}

/**
 * The delta sentence, with samples.
 *
 * The counts are the headline; the samples exist because a count with no
 * example is a claim nobody can check. Capped at three — a monorepo adding 400
 * nodes is one sentence, not a list, and a report nobody reaches the end of is a
 * report nobody reads. That is the same rule `reconcile.ts` applies to
 * unresolved imports, for the same reason.
 */
function describeDelta(
  delta: ReconcileDelta,
  findings: AuthoredFinding[],
  applied: boolean
): string {
  const headline = formatDelta(delta, findings, applied);
  const samples: string[] = [];

  for (const id of delta.addedNodes.slice(0, 3)) samples.push(`+ ${id}`);
  if (delta.addedNodes.length > 3) samples.push(`… and ${delta.addedNodes.length - 3} more`);
  for (const id of delta.removedNodes.slice(0, 3)) samples.push(`- ${id}`);
  if (delta.removedNodes.length > 3) {
    samples.push(`… and ${delta.removedNodes.length - 3} more`);
  }

  if (samples.length === 0) return headline;
  return `${headline}\n${samples.map((line) => `  ${line}`).join("\n")}`;
}

/** Node ids on the current document that carry human provenance. For diagnostics. */
export function humanVerifiedNodes(document: ArchitectureDocument): GraphNode[] {
  return document.nodes.filter((node) => isHumanVerified(node));
}