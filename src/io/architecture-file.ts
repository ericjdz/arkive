import { readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { validateArchitecture } from "../schema/validate.js";
import type { Architecture } from "../schema/types.js";
import { writeFileAtomic, cleanupStaleTempFiles } from "./atomic-write.js";
import { applyZodDefaults, contentHash } from "./preserve.js";

export const ARCHITECTURE_FILENAME = "architecture.json";
export const ARKIVE_DIR = "arkive";

/**
 * The document on disk is the user's, not ours. This type is the on-disk shape
 * we are able to reason about — the schema's fields, plus the one integrity
 * flag ADR-0006 requires. Keys neither of those knows about still round-trip
 * through every read and write; see `preserve.ts`.
 */
export interface ArchitectureDocument extends Architecture {
  /**
   * Set when history entries have been dropped from this document. Truncation
   * is never silent: the flag stays until a human removes it.
   */
  historyTruncated?: boolean;
}

/** ADR-0002: `history[]` is capped. The durable record is git. */
export const MAX_HISTORY_ENTRIES = 50;

/** ADR-0002: `arkive/history/` holds at most this many distinct states. */
export const MAX_SNAPSHOTS = 10;

export type ReadResult =
  | { success: true; data: ArchitectureDocument }
  | { success: false; error: string };

export type WriteResult =
  | { success: true; data: ArchitectureDocument }
  | { success: false; error: string };

export function arkiveDirPath(dir: string): string {
  return join(dir, ARKIVE_DIR);
}

export function architecturePath(dir: string): string {
  return join(dir, ARKIVE_DIR, ARCHITECTURE_FILENAME);
}

export function readArchitecture(dir: string): ReadResult {
  const path = architecturePath(dir);

  if (!existsSync(path)) {
    return {
      success: false,
      error: `architecture.json not found in ${join(dir, ARKIVE_DIR)}. Run \`arkive init\` first.`,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return {
      success: false,
      error: `Failed to read ${path}: ${(err as Error).message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      success: false,
      error: `Failed to parse ${path} as JSON: ${(err as Error).message}`,
    };
  }

  const validation = validateArchitecture(parsed);
  if (!validation.success) {
    return {
      success: false,
      error: `architecture.json failed schema validation: ${validation.error}`,
    };
  }

  // ADR-0006 §3. The schema produced *diagnostics*, not the document. What gets
  // handed back is the parsed file, with schema defaults filling only the gaps
  // it left. Writing `validation.data` here would strip every key this arkive
  // version does not recognise — the silent-destruction class the ADR closes.
  return { success: true, data: applyZodDefaults(parsed, validation.data) };
}

/**
 * Trim `history[]` to the newest `MAX_HISTORY_ENTRIES` and say so.
 *
 * The flag is sticky: once entries have been dropped, the document says it
 * forever. Un-setting it automatically would be a second, quieter loss.
 */
export function capHistory(document: Architecture): ArchitectureDocument {
  if (!Array.isArray(document.history)) return document;
  if (document.history.length <= MAX_HISTORY_ENTRIES) return document;

  return {
    ...document,
    history: document.history.slice(-MAX_HISTORY_ENTRIES),
    historyTruncated: true,
  };
}

export function writeArchitecture(
  dir: string,
  architecture: Architecture
): WriteResult {
  const next = {
    ...architecture,
    project: {
      ...architecture.project,
      lastUpdated: new Date().toISOString(),
    },
  } as ArchitectureDocument;

  const validation = validateArchitecture(next);
  if (!validation.success) {
    return {
      success: false,
      error: `Refusing to write invalid architecture: ${validation.error}`,
    };
  }

  // Same rule as the read: validate into a side channel, write the document.
  const document = capHistory(applyZodDefaults(next, validation.data));

  const path = architecturePath(dir);
  mkdirSync(arkiveDirPath(dir), { recursive: true });
  try {
    writeFileAtomic(path, JSON.stringify(document, null, 2) + "\n");
  } catch (err) {
    return {
      success: false,
      error: `Failed to write ${path}: ${(err as Error).message}`,
    };
  }

  try {
    saveSnapshot(dir, document);
  } catch {
    // Snapshot failure should not break the main write
  }

  return { success: true, data: document };
}

const HISTORY_DIR = "history";

/** Filesystem-safe stamp. `:` alone leaves `.` intact, so two writes in the
 * same millisecond collide and the second silently overwrites the first. */
function safeStamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

/**
 * The state of a document, with the volatile fields normalised out.
 *
 * `lastUpdated` changes on every single write, so hashing the document as-is
 * would make every write a "distinct state" and defeat the dedup entirely.
 */
function snapshotState(document: ArchitectureDocument): unknown {
  return { ...document, project: { ...document.project, lastUpdated: "" } };
}

function snapshotFileNames(historyDir: string): string[] {
  if (!existsSync(historyDir)) return [];
  return readdirSync(historyDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

function pruneSnapshots(historyDir: string): void {
  const names = snapshotFileNames(historyDir);
  for (const name of names.slice(0, Math.max(0, names.length - MAX_SNAPSHOTS))) {
    try {
      unlinkSync(join(historyDir, name));
    } catch {
      // Another process may have pruned it first.
    }
  }
}

/**
 * Record a state transition in `arkive/history/`.
 *
 * ADR-0002 rejected "full copy on every write, just cap the count" — that
 * stores the same file 200 times and calls it history. States are deduplicated
 * by content hash and the directory is capped at `MAX_SNAPSHOTS` distinct
 * states, so what remains is a record of what actually changed.
 *
 * Returns the path of the snapshot for this state, which may predate the
 * current write: that is the dedup working.
 */
export function saveSnapshot(dir: string, architecture: ArchitectureDocument): string {
  const historyDir = join(dir, ARKIVE_DIR, HISTORY_DIR);
  mkdirSync(historyDir, { recursive: true });
  cleanupStaleTempFiles(historyDir);

  const state = snapshotState(architecture);
  const hash = contentHash(state);

  const existing = snapshotFileNames(historyDir).find((name) =>
    name.endsWith(`--${hash}.json`)
  );
  if (existing) {
    return join(historyDir, existing);
  }

  const stamp = safeStamp(architecture.project.lastUpdated || new Date().toISOString());
  const snapshotPath = join(historyDir, `${stamp}--${hash}.json`);

  writeFileAtomic(snapshotPath, JSON.stringify(architecture, null, 2) + "\n");
  pruneSnapshots(historyDir);

  return snapshotPath;
}

export function listSnapshots(dir: string): string[] {
  return snapshotFileNames(join(dir, ARKIVE_DIR, HISTORY_DIR)).map((f) =>
    f.replace(/\.json$/, "")
  );
}

export function readSnapshot(dir: string, timestamp: string): ReadResult {
  const historyDir = join(dir, ARKIVE_DIR, HISTORY_DIR);
  const snapshotPath = join(historyDir, `${timestamp}.json`);

  if (!existsSync(snapshotPath)) {
    return {
      success: false,
      error: `Snapshot not found: ${timestamp}`,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(snapshotPath, "utf-8");
  } catch (err) {
    return {
      success: false,
      error: `Failed to read snapshot: ${(err as Error).message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      success: false,
      error: `Failed to parse snapshot as JSON: ${(err as Error).message}`,
    };
  }

  const validation = validateArchitecture(parsed);
  if (!validation.success) {
    return {
      success: false,
      error: `Snapshot failed schema validation: ${validation.error}`,
    };
  }

  return { success: true, data: applyZodDefaults(parsed, validation.data) };
}

/** Exported for tests that assert on the snapshot bound (ADR-0006 test L). */
export function snapshotCount(dir: string): number {
  const historyDir = join(dir, ARKIVE_DIR, HISTORY_DIR);
  if (!existsSync(historyDir)) return 0;
  return readdirSync(historyDir).filter((f) => f.endsWith(".json")).length;
}