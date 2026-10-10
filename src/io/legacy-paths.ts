import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHITECTURE_FILENAME, ARKIVE_DIR, architecturePath } from "./architecture-file.js";

/**
 * Migration detection. ADR-0006 §1.
 *
 * Commit `62066bc` moved the document from `<root>/architecture.json` to
 * `<root>/arkive/architecture.json`. The code path moved; the data did not. A
 * blank scaffold appeared at the new path, the real document — 7 services,
 * 4 decisions, 3 dataFlows — was orphaned at the old one, and both files
 * existed side by side with nothing warning about it.
 *
 * `init` could not notice, because "the new path does not exist" and "the old
 * path holds everything" are the same test. This module makes them different
 * tests.
 */

export interface LegacyPathEntry {
  /** Location relative to the project root, e.g. `architecture.json`. */
  relativePath: string;
  /** Version range in which this location was the live one. */
  versions: string;
  /** Why this entry exists. Kept so a future reader does not "tidy" it away. */
  reason: string;
}

/**
 * Every location the architecture document has ever lived at.
 *
 * Adding a path constant with no entry here fails
 * `tests/io/legacy-paths.test.ts`. That test is the build-time guard ADR-0006
 * asked for.
 */
export const LEGACY_PATHS: readonly LegacyPathEntry[] = [
  {
    relativePath: ARCHITECTURE_FILENAME,
    versions: "arkive <= 0.2.1",
    reason:
      "Pre-62066bc layout, when the project was named archlearn. Commit 62066bc " +
      "moved the code path to arkive/architecture.json and scaffolded an empty " +
      "document there without moving the data. The real document was orphaned " +
      "here and four recorded decisions were destroyed silently.",
  },
];

export type ProbeStatus =
  /** A document at the current path. Normal operation. */
  | "current"
  /** No document anywhere. Normal fresh init. */
  | "fresh"
  /** A document at a prior path and none at the current path. */
  | "legacy-only"
  /** Documents at both. Worse: there is no correct automatic choice. */
  | "ambiguous";

export interface DocumentCounts {
  services: number;
  connections: number;
  decisions: number;
  dataFlows: number;
  history: number;
}

export interface DocumentSummary {
  path: string;
  counts: DocumentCounts | null;
  /** Set when the file exists but could not be counted (invalid JSON, etc). */
  error?: string;
}

export interface LegacyHit extends DocumentSummary {
  entry: LegacyPathEntry;
}

export interface DocumentProbe {
  root: string;
  status: ProbeStatus;
  /** Absolute path of the current document, whether or not it exists. */
  currentPath: string;
  current: DocumentSummary | null;
  legacy: LegacyHit[];
}

/**
 * Count what is actually in a document. Defensive by design: this runs on files
 * that may be malformed, and a count failure must not become a crash on the
 * path that is trying to *report* a problem.
 */
export function summarizeDocument(path: string): DocumentSummary {
  if (!existsSync(path)) {
    return { path, counts: null };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const count = (key: string): number => {
      const value = parsed[key];
      return Array.isArray(value) ? value.length : 0;
    };

    return {
      path,
      counts: {
        services: count("services"),
        connections: count("connections"),
        decisions: count("decisions"),
        dataFlows: count("dataFlows"),
        history: count("history"),
      },
    };
  } catch (err) {
    return { path, counts: null, error: (err as Error).message };
  }
}

function formatCounts(summary: DocumentSummary): string {
  if (summary.error) return `unreadable (${summary.error})`;
  if (!summary.counts) return "no counts available";
  const c = summary.counts;
  return (
    `${c.services} services, ${c.connections} connections, ` +
    `${c.decisions} decisions, ${c.dataFlows} dataFlows, ${c.history} history`
  );
}

export function relativeTo(root: string, path: string): string {
  return path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]/, "") : path;
}

/**
 * The mandatory startup probe. Every entry point runs this before it writes
 * anything.
 *
 * Never infers which document is newer. In this repository the *blank scaffold*
 * is newer by mtime than the real document it destroyed, so mtime is not
 * evidence — see ADR-0006, "Alternatives considered".
 */
export function probeDocumentPaths(root: string): DocumentProbe {
  const currentPath = architecturePath(root);
  const currentExists = existsSync(currentPath);
  const current = currentExists ? summarizeDocument(currentPath) : null;

  const legacy: LegacyHit[] = [];
  for (const entry of LEGACY_PATHS) {
    const path = join(root, entry.relativePath);
    if (existsSync(path)) {
      legacy.push({ ...summarizeDocument(path), entry });
    }
  }

  let status: ProbeStatus;
  if (legacy.length > 0) {
    status = currentExists ? "ambiguous" : "legacy-only";
  } else {
    status = currentExists ? "current" : "fresh";
  }

  return { root, status, currentPath, current, legacy };
}

/** `true` when `init` (or any writer) must refuse to proceed. */
export function probeBlocksWrite(probe: DocumentProbe): boolean {
  return probe.status === "legacy-only" || probe.status === "ambiguous";
}

/**
 * The refusal message.
 *
 * It names both paths, prints both counts, and says what to do. Refusing
 * *silently* was the original defect — the refusal has to be loud enough that
 * it cannot be scrolled past.
 */
export function describeProbeConflict(probe: DocumentProbe): string {
  const rel = (path: string) => relativeTo(probe.root, path);
  const lines: string[] = [];

  lines.push("");
  lines.push(
    probe.status === "ambiguous"
      ? "  arkive found architecture documents at more than one path."
      : "  arkive found an architecture document at a path it no longer uses."
  );
  lines.push("");
  lines.push("  Nothing has been written. Nothing has been moved. Nothing has been deleted.");
  lines.push("");

  if (probe.status === "ambiguous" && probe.current) {
    lines.push(`    current path   ${rel(probe.current.path)}`);
    lines.push(`                    ${formatCounts(probe.current)}`);
    lines.push("");
  }

  for (const hit of probe.legacy) {
    lines.push(`    previous path  ${rel(hit.path)}   (${hit.entry.versions})`);
    lines.push(`                    ${formatCounts(hit)}`);
    if (probe.status === "legacy-only" && hit.counts && hit.counts.decisions > 0) {
      lines.push(
        `                    ^ ${hit.counts.decisions} recorded decision(s) live only here.`
      );
    }
    lines.push("");
  }

  lines.push("  arkive will not scaffold over an existing document, and will not guess");
  lines.push("  which one is real. Refusing here is the fix for the bug where a path");
  lines.push("  migration wrote an empty document beside the real one (see ADR-0006).");
  lines.push("");
  lines.push("  To resolve this:");
  lines.push(`    1. Move the document yourself:  mv "${rel(probe.legacy[0].path)}" "${ARKIVE_DIR}/${ARCHITECTURE_FILENAME}"`);
  lines.push("       Keep a copy of the old file until you have confirmed the new one is right.");
  lines.push(`    2. Then re-run:                 arkive init --dir "${rel(probe.root) || "."}"`);
  lines.push("");

  return lines.join("\n");
}