import { readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ArchitectureSchema } from "../schema/architecture.js";
import type { Architecture } from "../schema/types.js";
import { CURRENT_SCHEMA_VERSION } from "../schema/graph.js";
import type { ArchitectureDocumentV2, GraphDecision } from "../schema/graph.js";
import { validateGraphDocument } from "../schema/validate-graph.js";
import type { GraphWarning } from "../schema/validate-graph.js";
import { detectSchemaVersion, migrateDocument, orphanEdges } from "../schema/migrate.js";
import { writeFileAtomic, cleanupStaleTempFiles } from "./atomic-write.js";
import { applyZodDefaults, contentHash } from "./preserve.js";
import { projectDocument } from "./project.js";
import type { ProjectedConnection, ProjectedService } from "./project.js";
import {
  carryLegacyServiceFields,
  carryV1UnknownKeys,
  foldV1ViewOntoGraph,
  normaliseDecisions,
  validateV1Authoring,
  validateV1View,
} from "./v1-authoring.js";

export const ARCHITECTURE_FILENAME = "architecture.json";
export const ARKIVE_DIR = "arkive";

/** ADR-0002: `history[]` is capped. The durable record is git. */
export const MAX_HISTORY_ENTRIES = 50;

/** ADR-0002: `arkive/history/` holds at most this many distinct states. */
export const MAX_SNAPSHOTS = 10;

/**
 * What `readArchitecture` hands back, and what every current caller already
 * expects to find.
 *
 * The graph (`nodes` / `edges`) is the truth — ADR-0001:57-88. The rest of the
 * v1 surface is still here because issue 0004 §4 requires it during the
 * transition, and because the constraint that decides it is concrete: eight MCP
 * tools, six viewer views, the mermaid exporter, `buildSessionContext` and two
 * skills read `.services` / `.connections` / `.decisions[].relatedServices`
 * today, and none of those files are in this change. A projection that only
 * existed at the MCP boundary would break the file-reading skills outright and
 * would require editing `src/server/tools.ts`, which another agent owns this
 * wave.
 *
 * So the v1 fields are present, derived, and cannot become truth: `project.ts`
 * computes them from the graph on every read, `writeArchitecture` folds them
 * back onto the graph and recomputes them, and the copy written to disk is
 * always the recomputed one. Two writes of the same graph produce
 * byte-identical projections, and an edit to a stored copy alone is invisible
 * to the next read.
 */
export interface ArchitectureDocument extends Architecture {
  /** The v2 discriminator. An integer with no default, so a v1 file cannot be
   *  parsed as v2 by accident (ADR-0001:119-134). */
  schemaVersion: number;
  /** The graph. Authoritative. */
  nodes: ArchitectureDocumentV2["nodes"];
  edges: ArchitectureDocumentV2["edges"];
  /**
   * @deprecated Derived from `nodes` by `project.ts`. Never authoritative,
   * never an input to a read. Present because eight MCP tools and the viewer
   * still speak v1; `writeArchitecture` folds edits back onto the graph and
   * recomputes this from it.
   */
  services: ProjectedService[];
  /** @deprecated Derived from `edges`. See `services`. */
  connections: ProjectedConnection[];
  /** `subjects` is authoritative; `relatedServices` is projected from it. */
  decisions: Array<GraphDecision & { relatedServices: string[] }>;
  /**
   * Set when history entries have been dropped from this document. Truncation is
   * never silent: the flag stays until a human removes it.
   */
  historyTruncated?: boolean;
  /** Semantic warnings from `validateGraphDocument`, never discarded. */
  warnings?: GraphWarning[];
}

export type ReadResult =
  | { success: true; data: ArchitectureDocument }
  | { success: false; error: string };

export type WriteResult =
  | { success: true; data: ArchitectureDocument }
  | { success: false; error: string };

/**
 * Anything `writeArchitecture` will accept.
 *
 * Two shapes are in circulation and both must keep working: a fresh
 * `createEmptyArchitectureV2()` from `init.ts` (pure v2) and a
 * `readArchitecture` result whose `services` were mutated in place by
 * `handleUpdateArchitecture` (v2 plus a v1 edit). The last member of the union
 * is a pure v1 document, which only pre-0.3 callers and test fixtures produce.
 */
export type ArchitectureWriteInput =
  | ArchitectureDocument
  | ArchitectureDocumentV2
  | Architecture
  | (Partial<Architecture> & Record<string, unknown>);

export function arkiveDirPath(dir: string): string {
  return join(dir, ARKIVE_DIR);
}

export function architecturePath(dir: string): string {
  return join(dir, ARKIVE_DIR, ARCHITECTURE_FILENAME);
}

function fail(error: string): ReadResult {
  return { success: false, error };
}

/** Parse, distinguishing "unreadable file" from "unclassifiable document". */
function readJson(
  path: string,
  label: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { ok: false, error: `Failed to read ${label}: ${(err as Error).message}` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse ${label} as JSON: ${(err as Error).message}`,
    };
  }
}

type LoadedGraph =
  | { ok: true; graph: ArchitectureDocumentV2; fromVersion: number }
  | { ok: false; error: string };

/**
 * The one path from a parsed JSON value to a v2 graph.
 *
 * Shared by `readArchitecture`, `readSnapshot` and `writeArchitecture` so the
 * three cannot drift apart — the same reason `project.ts` is a single module.
 *
 * ### Why the v1 branch validates the shape but not the references
 *
 * It runs `ArchitectureSchema` (shape only) and **not** `validateArchitecture`
 * (shape *and* referential integrity):
 *
 * - `migrateDocument` calls `migrateV1ToV2` directly, and that reads
 *   `v1.services.map(...)`. A document with no `services` key crashes it, so the
 *   shape has to be settled first. Zod's `.default()`s fill the gap, which is
 *   also what keeps `read.data.services` defined for a sparse document.
 * - Dropping the referential half is a deliberate loosening on the **read** path,
 *   and it is the one both ADR-0001 and ADR-0006 ask for: a connection to a
 *   service the user has since deleted has to survive being read, preserved as
 *   `dangling: true` and reported by `reconcile`. Refusing to read it would
 *   hide the broken reference; deleting it would be `62066bc`.
 *
 * The authoring half of that rule still exists, on `writeArchitecture`, where it
 * belongs.
 */
function loadGraph(value: unknown): LoadedGraph {
  const detected = detectSchemaVersion(value);
  if (detected === null) {
    return {
      ok: false,
      error:
        "not a recognisable architecture document: expected an integer " +
        `\`schemaVersion\` (v${CURRENT_SCHEMA_VERSION}), or a v1 \`version\` string / ` +
        "`project` block. Refusing to guess.",
    };
  }

  if (detected === 1) {
    const parsed = ArchitectureSchema.safeParse(value);
    if (!parsed.success) {
      return {
        ok: false,
        error:
          "failed v1 schema validation: " +
          parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; "),
      };
    }

    // Defaults merged back in, unknown keys intact — `applyZodDefaults` is what
    // keeps both properties at once.
    const v1 = applyZodDefaults(value, parsed.data);
    const migration = migrateDocument(v1);
    if (!migration.success) {
      return { ok: false, error: migration.error };
    }

    // Two repairs the pure migration deliberately does not make, both aimed at
    // making it *lossless* rather than at changing its meaning.
    //
    // `carryLegacyServiceFields` keeps `type`, `source` and `confidence` so the
    // v1 projection round-trips and `drift.ts` keeps its low-confidence rule.
    // `carryV1UnknownKeys` moves every key the v1 schema did not recognise onto
    // the migrated element it came from — without it, upgrading a document
    // silently deletes the user's own fields, which is the class ADR-0006 §3
    // exists to close, reintroduced by the migration itself.
    const carried = carryV1UnknownKeys(
      v1,
      parsed.data,
      carryLegacyServiceFields(parsed.data, migration.data)
    );
    return { ok: true, graph: carried, fromVersion: 1 };
  }

  const migration = migrateDocument(stripRegenerated(value as Record<string, unknown>));
  if (!migration.success) {
    return { ok: false, error: migration.error };
  }
  return { ok: true, graph: migration.data, fromVersion: detected };
}

/**
 * Keys that are regenerated from the graph and must never be carried across
 * from a source document.
 *
 * `version` is *replaced* by `schemaVersion` (ADR-0001:121-127): a defaulted
 * semver string that parsed successfully under the wrong reader and was never
 * branched on. Persisting it alongside `schemaVersion` would be the worst of
 * both worlds — two version fields, one of which is decorative and one of
 * which gates the migration.
 *
 * `services` / `connections` are recomputed by `project.ts` from the folded
 * graph. Carrying them across would let an edit to the stored copy skip the
 * fold, which is the one thing the whole projection design exists to prevent.
 */
const REGENERATED_KEYS: ReadonlySet<string> = new Set([
  "version",
  "services",
  "connections",
]);

function stripRegenerated(value: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...value };
  for (const key of REGENERATED_KEYS) delete copy[key];
  return copy;
}

/**
 * Read the document, migrate it in memory, return the v2 graph.
 *
 * **Side-effect free, by construction.** ADR-0006 rejected auto-migrate-on-read
 * and issue 0004 §3 requires it: "a read that rewrites the file loses data to a
 * tool someone ran while curious". Nothing below writes. The migration result
 * is returned in memory and persisted only by the next explicit `write`.
 *
 * `detectSchemaVersion` is the in-memory half of ADR-0006 §1's path probe: a v1
 * document routes to `migrateDocument`, a v2 document validates directly, and a
 * document from the future is a hard error rather than a best-effort parse.
 */
export function readArchitecture(dir: string): ReadResult {
  const path = architecturePath(dir);

  if (!existsSync(path)) {
    return fail(
      `architecture.json not found in ${join(dir, ARKIVE_DIR)}. Run \`arkive init\` first.`
    );
  }

  const raw = readJson(path, path);
  if (!raw.ok) return fail(raw.error);

  const loaded = loadGraph(raw.value);
  if (!loaded.ok) return fail(`${path}: ${loaded.error}`);

  const validation = validateGraphDocument(loaded.graph);
  if (!validation.success) {
    return fail(`${path} failed schema validation: ${validation.error}`);
  }

  // ADR-0006 §3: Zod supplies diagnostics, not the document. For v2 this is
  // near-identity — the schema is defaultless, so `parse(x)` deep-equals `x`
  // and `looseObject` costs nothing — and it is what keeps a hand-added key
  // alive on a document this build does not fully understand.
  const document = applyZodDefaults(loaded.graph, validation.data);
  return {
    success: true,
    data: projectOnto(document, loaded.fromVersion, validation.warnings),
  };
}

/**
 * Attach the deprecated v1 view to a validated graph.
 *
 * Single entry point so `readArchitecture`, `writeArchitecture` and
 * `readSnapshot` cannot disagree about what the projection is — ADR-0001
 * rejects a stored `services[]` for exactly this reason: "Two writers, no
 * reconciler, guaranteed divergence."
 *
 * The graph is spread first so every unknown key on it survives into the
 * returned document and therefore into the next write. Building the object
 * field-by-field would quietly drop every hand-added key on the way out, which
 * is the same failure the return type is meant to prevent.
 */
function projectOnto(
  graph: ArchitectureDocumentV2,
  sourceVersion: number,
  warnings: GraphWarning[] = []
): ArchitectureDocument {
  const projected = projectDocument(graph);

  const document: ArchitectureDocument = {
    ...(graph as unknown as Architecture),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    // `version` was a defaulted semver string nothing branched on
    // (ADR-0001:121-127). It is now an honest report of what was on disk, so a
    // caller can tell a v1 file from a v2 one without inspecting the graph.
    version: sourceVersion === 1 ? "1.0.0" : `${CURRENT_SCHEMA_VERSION}.0.0`,
    project: graph.project,
    stack: graph.stack,
    nodes: graph.nodes,
    edges: graph.edges,
    services: projected.services,
    connections: projected.connections,
    decisions: normaliseDecisions(graph.decisions),
    dataFlows: graph.dataFlows,
    history: graph.history,
  };

  // Preserved rather than recomputed: a document truncated once says so forever,
  // and the flag has to survive a round trip through a shape that does not know
  // the field. `looseObject` keeps it on the graph; this puts it back in a typed
  // place.
  const truncated = (graph as Record<string, unknown>).historyTruncated;
  if (truncated !== undefined) document.historyTruncated = truncated as boolean;

  const dangling = orphanEdges(graph);
  if (dangling.length > 0) {
    document.warnings = [
      ...warnings,
      {
        code: "dangling-edge" as const,
        message:
          `${dangling.length} preserved edge(s) point at something that no longer ` +
          `exists: ${dangling.map((edge) => edge.id).join(", ")}. These were kept ` +
          `deliberately — deleting a relationship the author wrote is the ` +
          `62066bc failure class. Fix or remove them.`,
        path: "edges",
      },
    ];
  } else if (warnings.length > 0) {
    document.warnings = warnings;
  }

  return document;
}

/**
 * Trim `history[]` to the newest `MAX_HISTORY_ENTRIES` and say so.
 *
 * The flag is sticky: once entries have been dropped, the document says it
 * forever. Un-setting it automatically would be a second, quieter loss.
 */
export function capHistory<T extends { history: unknown[] }>(
  document: T
): T & { historyTruncated?: boolean } {
  if (!Array.isArray(document.history)) return document;
  if (document.history.length <= MAX_HISTORY_ENTRIES) return document;

  return {
    ...document,
    history: document.history.slice(-MAX_HISTORY_ENTRIES),
    historyTruncated: true,
  };
}

/**
 * Persist a document as v2.
 *
 * Accepts either shape, because both are in circulation: a fresh
 * `createEmptyArchitectureV2()` from `init.ts`, and a `readArchitecture` result
 * with `services[]` mutated in place by `handleUpdateArchitecture`.
 *
 * The order below is the whole point of the function.
 *
 *  1. **Load.** Route through the same `loadGraph` the read path uses.
 *  2. **Fold.** A v1 view on the input is a set of edits against the graph, and
 *     they have to land before anything is validated. Applying them first means
 *     a decision's `subjects` resolve against the edited graph, and the copy
 *     written back is computed from the post-edit graph.
 *  3. **Validate** with `validateGraphDocument`, not `validateArchitecture`. The
 *     graph is what is persisted, so the v2 invariants are the ones that apply:
 *     unique ids, edges resolving to live nodes, dangling edges preserved rather
 *     than dropped.
 *  4. **Stamp** `schemaVersion`.
 *  5. **Cap history**, write atomically, snapshot.
 *
 * `services[]` / `connections[]` are always written from the folded graph and
 * never from the input, so an edit to a stored copy alone cannot become truth.
 */
export function writeArchitecture(
  dir: string,
  architecture: ArchitectureWriteInput
): WriteResult {
  const record = stampLastUpdated(architecture) as Record<string, unknown>;

  const hasGraph = Array.isArray(record.nodes) && Array.isArray(record.edges);
  const hasV1View = Array.isArray(record.services);
  if (!hasGraph && !hasV1View) {
    return {
      success: false,
      error:
        "Refusing to write: the document carries neither a v2 graph " +
        "(`nodes`/`edges`) nor a v1 view (`services`).",
    };
  }

  const loaded = loadGraph(record);
  if (!loaded.ok) {
    return { success: false, error: `Refusing to write: ${loaded.error}` };
  }

  const base = loaded.graph;
  const connections = Array.isArray(record.connections)
    ? (record.connections as ProjectedConnection[])
    : [];

  if (hasV1View) {
    const services = record.services as ProjectedService[];
    // The v1 referential rules still apply to a v1 *edit*, and that is what
    // stops a typo becoming a permanent dangling edge.
    //
    // Two exemptions differ by path, deliberately:
    //  - over an existing graph, a connection already preserved as `dangling` is
    //    history the user wrote before the node went away. Refusing to write
    //    that document again would make every migrated document with one stale
    //    reference permanently unwritable.
    //  - on a document authored from scratch, nothing is history, so nothing is
    //    excused.
    const v1Error = hasGraph
      ? validateV1Authoring(base, services, connections)
      : validateV1View(services, connections);
    if (v1Error) return { success: false, error: `Refusing to write: ${v1Error}` };

    if (hasGraph) {
      Object.assign(
        base,
        foldV1ViewOntoGraph(base, services, connections).graph
      );
    }
  }

  base.schemaVersion = CURRENT_SCHEMA_VERSION;
  base.decisions = normaliseDecisions(base.decisions);

  const capped = capHistory(base);
  const graph = { ...capped, schemaVersion: CURRENT_SCHEMA_VERSION };

  const validation = validateGraphDocument(graph);
  if (!validation.success) {
    return {
      success: false,
      error: `Refusing to write invalid architecture: ${validation.error}`,
    };
  }

  // ADR-0006 §3, once more, now that a fold may have introduced elements:
  // serialise the document, never `validation.data`. v2 is defaultless so this
  // is near-identity, but the rule is what keeps a hand-added key alive across
  // an `update_architecture` call.
  const persisted = applyZodDefaults(graph, validation.data) as ArchitectureDocumentV2;

  const path = architecturePath(dir);
  mkdirSync(arkiveDirPath(dir), { recursive: true });
  try {
    writeFileAtomic(path, `${JSON.stringify(withDerivedView(persisted), null, 2)}\n`);
  } catch (err) {
    return { success: false, error: `Failed to write ${path}: ${(err as Error).message}` };
  }

  try {
    saveSnapshot(dir, withDerivedView(persisted) as unknown as ArchitectureDocumentV2);
  } catch {
    // Snapshot failure must not fail the write that already committed.
  }

  return {
    success: true,
    data: projectOnto(persisted, CURRENT_SCHEMA_VERSION, validation.warnings),
  };
}

/**
 * What actually lands on disk: the v2 graph, plus the regenerated v1 view.
 *
 * The `services[]` / `connections[]` on disk exist so a v1 *reader* — the
 * `architecture-tracker` skill, a human in an editor, an older arkive — still
 * gets a usable document. They are written here and nowhere else, always from
 * the graph, and `readArchitecture` recomputes them on the way back in rather
 * than trusting them.
 */
function withDerivedView(graph: ArchitectureDocumentV2): Record<string, unknown> {
  const projected = projectDocument(graph);
  const record: Record<string, unknown> = { ...graph };
  record.services = projected.services;
  record.connections = projected.connections;
  return record;
}

function stampLastUpdated(architecture: ArchitectureWriteInput): ArchitectureWriteInput {
  const project = (architecture as { project?: Record<string, unknown> }).project;
  if (!project || typeof project !== "object" || Array.isArray(project)) return architecture;
  return {
    ...architecture,
    project: { ...project, lastUpdated: new Date().toISOString() },
  } as ArchitectureWriteInput;
}

const HISTORY_DIR = "history";

/** Filesystem-safe stamp. `:` alone leaves `.` intact, so two writes in the
 *  same millisecond collide and the second silently overwrites the first. */
function safeStamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

/**
 * The state of a document, with the volatile fields normalised out.
 *
 * `lastUpdated` changes on every single write, so hashing the document as-is
 * would make every write a distinct state and defeat the dedup entirely.
 */
function snapshotState(document: ArchitectureDocumentV2): unknown {
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
 * ADR-0002 rejected "full copy on every write, just cap the count" — that stores
 * the same file 200 times and calls it history. States are deduplicated by
 * content hash and the directory is capped at `MAX_SNAPSHOTS` distinct states,
 * so what remains is a record of what actually changed.
 *
 * Returns the path of the snapshot for this state, which may predate the current
 * write: that is the dedup working.
 */
export function saveSnapshot(dir: string, architecture: ArchitectureDocumentV2): string {
  const historyDir = join(dir, ARKIVE_DIR, HISTORY_DIR);
  mkdirSync(historyDir, { recursive: true });
  cleanupStaleTempFiles(historyDir);

  const hash = contentHash(snapshotState(architecture));

  const existing = snapshotFileNames(historyDir).find((name) =>
    name.endsWith(`--${hash}.json`)
  );
  if (existing) {
    return join(historyDir, existing);
  }

  const stamp = safeStamp(architecture.project.lastUpdated || new Date().toISOString());
  const snapshotPath = join(historyDir, `${stamp}--${hash}.json`);

  writeFileAtomic(snapshotPath, `${JSON.stringify(architecture, null, 2)}\n`);
  pruneSnapshots(historyDir);

  return snapshotPath;
}

export function listSnapshots(dir: string): string[] {
  return snapshotFileNames(join(dir, ARKIVE_DIR, HISTORY_DIR)).map((f) =>
    f.replace(/\.json$/, "")
  );
}

/**
 * Read a snapshot back through the same path as the live document.
 *
 * A snapshot written before this change is a v1 file, so it gets the same
 * probe-and-migrate treatment. Anything else makes every pre-existing snapshot
 * unreadable the moment v2 ships.
 */
export function readSnapshot(dir: string, timestamp: string): ReadResult {
  const historyDir = join(dir, ARKIVE_DIR, HISTORY_DIR);
  const snapshotPath = join(historyDir, `${timestamp}.json`);

  if (!existsSync(snapshotPath)) {
    return { success: false, error: `Snapshot not found: ${timestamp}` };
  }

  const raw = readJson(snapshotPath, `Snapshot ${timestamp}`);
  if (!raw.ok) return fail(raw.error);

  const loaded = loadGraph(raw.value);
  if (!loaded.ok) return fail(`Snapshot failed schema validation: ${loaded.error}`);

  const validation = validateGraphDocument(loaded.graph);
  if (!validation.success) {
    return fail(`Snapshot failed schema validation: ${validation.error}`);
  }

  const document = applyZodDefaults(loaded.graph, validation.data);
  return {
    success: true,
    data: projectOnto(document, loaded.fromVersion, validation.warnings),
  };
}

/** Exported for tests that assert on the snapshot bound (ADR-0006 test L). */
export function snapshotCount(dir: string): number {
  const historyDir = join(dir, ARKIVE_DIR, HISTORY_DIR);
  if (!existsSync(historyDir)) return 0;
  return readdirSync(historyDir).filter((f) => f.endsWith(".json")).length;
}