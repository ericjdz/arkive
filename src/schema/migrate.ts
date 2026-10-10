import { CURRENT_SCHEMA_VERSION } from "./graph.js";
import type {
  ArchitectureDocumentV2,
  DecisionSubject,
  GraphEdge,
  GraphNode,
  StorableEdgeKind,
} from "./graph.js";
import type { Architecture } from "./types.js";
import { authoredBy } from "./provenance.js";

/**
 * `migrate(1) -> 2`.
 *
 * Pure: it reads the v1 document, builds a new one, and never touches the
 * input. Calling it twice on the same input produces the same output, and
 * passing an already-v2 document through `migrateDocument` is a no-op
 * (ADR-0006 regression test I).
 *
 * Losslessness is the design constraint, not a property discovered by the
 * tests. Every v1 id survives, every v1 relationship survives as an edge, and
 * the two shapes that cannot be carried — a dangling `connections[]` endpoint
 * and a `relatedServices` id that no longer resolves — are carried *as broken
 * references*, never dropped (ADR-0001:141-149).
 */

export const MIGRATE_FROM_VERSION = 1;
export const MIGRATE_TO_VERSION = CURRENT_SCHEMA_VERSION;

/**
 * What provenance a migrated element gets.
 *
 * Not `derived`. A migration does not re-run static analysis, and marking a
 * transcribed v1 service as `derived: true` with a `rule` would be a
 * fabrication — it would assert that a rule produced something no rule ever
 * saw. v1 elements were transcribed by an agent, so `authoredBy: "agent"` with
 * no `reviewedAt` is the honest description, and it leaves every one of them
 * visible to ADR-0002's first drift rule ("an authored node whose kind is
 * derivable but which has no derivation").
 */
const MIGRATED_PROVENANCE = authoredBy("agent");

function edgeId(
  from: string,
  to: string,
  kind: StorableEdgeKind,
  taken: Set<string>
): string {
  const base = `${kind}:${from}->${to}`;
  let candidate = base;
  let ordinal = 2;
  while (taken.has(candidate)) {
    candidate = `${base}#${ordinal}`;
    ordinal += 1;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Migrates a v1 document to `schemaVersion: 2`.
 *
 * Transform, per ADR-0001:136-150:
 *  1. `services[]` → `nodes[]` with `kind: "service"`; `name`, `description`
 *     and `technology` are preserved (`description` → `summary`,
 *     `technology` → `tech`); the `type` taxonomy is dropped.
 *  2. `dependencies[]` → `imports` edges.
 *  3. `connections[]` → `calls` edges with `label: protocol`. An endpoint that
 *     does not resolve becomes `dangling: true` rather than being dropped.
 *  4. `decisions[].relatedServices` → `subjects[]`, unresolvable ids kept.
 *  5. `stack`, `project`, `dataFlows[]` and `history[]` carry over unchanged.
 *
 * `source` and `confidence` are not carried. ADR-0002 deletes them: they were
 * read by two call sites and written by no code path
 * (`docs/adr/0002-derived-by-default-memory.md:12-24`), so there is no
 * information in them to preserve.
 */
export function migrateV1ToV2(v1: Architecture): ArchitectureDocumentV2 {
  const nodes: GraphNode[] = v1.services.map((service) => {
    const node: GraphNode = {
      id: service.id,
      kind: "service",
      name: service.name,
      summary: service.description,
      tech: service.technology,
      provenance: MIGRATED_PROVENANCE,
    };
    if (service.ports !== undefined) {
      node.ports = [...service.ports];
    }
    return node;
  });

  const edges: GraphEdge[] = [];
  const takenEdgeIds = new Set<string>();

  // 2. `dependencies[]` → `imports` edges.
  for (const service of v1.services) {
    for (const dependency of service.dependencies) {
      edges.push({
        id: edgeId(service.id, dependency, "imports", takenEdgeIds),
        from: service.id,
        to: dependency,
        kind: "imports",
        provenance: MIGRATED_PROVENANCE,
      });
    }
  }

  // 3. `connections[]` → `calls` edges, dangling endpoints preserved.
  for (const connection of v1.connections) {
    const edge: GraphEdge = {
      id: edgeId(connection.from, connection.to, "calls", takenEdgeIds),
      from: connection.from,
      to: connection.to,
      kind: "calls",
      label: connection.protocol,
      provenance: MIGRATED_PROVENANCE,
    };
    if (connection.description !== "") {
      edge.note = connection.description;
    }
    if (
      !nodes.some((node) => node.id === connection.from) ||
      !nodes.some((node) => node.id === connection.to)
    ) {
      edge.dangling = true;
    }
    edges.push(edge);
  }

  // 4. `relatedServices` → `subjects`, unresolvable ids preserved (ADR-0001:146-149).
  const decisions = v1.decisions.map((decision) => {
    const subjects: DecisionSubject[] = decision.relatedServices.map((ref) => ({
      kind: "node",
      ref,
    }));
    return {
      id: decision.id,
      topic: decision.topic,
      decision: decision.decision,
      rationale: decision.rationale,
      alternatives: decision.alternatives.map((alternative) => ({
        name: alternative.name,
        whyNot: alternative.whyNot,
      })),
      timestamp: decision.timestamp,
      subjects,
    };
  });

  return {
    schemaVersion: MIGRATE_TO_VERSION,
    project: { ...v1.project },
    stack: {
      language: [...v1.stack.language],
      runtime: [...v1.stack.runtime],
      framework: [...v1.stack.framework],
      database: [...v1.stack.database],
      infrastructure: [...v1.stack.infrastructure],
    },
    nodes,
    edges,
    decisions,
    dataFlows: v1.dataFlows.map((flow) => ({
      name: flow.name,
      steps: flow.steps.map((step) => ({ actor: step.actor, action: step.action })),
    })),
    history: v1.history.map((entry) => {
      const migrated: ArchitectureDocumentV2["history"][number] = {
        timestamp: entry.timestamp,
        action: entry.action,
        summary: entry.summary,
      };
      if (entry.agent !== undefined) {
        migrated.agent = entry.agent;
      }
      return migrated;
    }),
  };
}

export type MigrationResult =
  | { success: true; data: ArchitectureDocumentV2; fromVersion: number }
  | { success: false; error: string; fromVersion: number | null };

/**
 * Classifies a raw parsed JSON value as a schema version.
 *
 * - a finite integer `schemaVersion` → that number
 * - a string `version`, or a v1-shaped object with a `project` and no
 *   `schemaVersion` → `1`
 * - anything else → `null`, and the caller must refuse rather than guess
 *
 * This is the in-memory half of ADR-0006's probe. Deciding where to call it —
 * and what to do when a second document exists at a legacy path — belongs to
 * `src/io/` and `src/cli/`, which are outside this issue.
 */
export function detectSchemaVersion(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;

  if (typeof record.schemaVersion === "number") {
    return Number.isInteger(record.schemaVersion) ? record.schemaVersion : null;
  }

  if (typeof record.version === "string") {
    return 1;
  }

  if (
    typeof record.project === "object" &&
    record.project !== null &&
    !Array.isArray(record.project)
  ) {
    return 1;
  }

  return null;
}

/**
 * Routes a raw document through the migration chain to
 * `CURRENT_SCHEMA_VERSION`.
 *
 * Pure: no file is read and no file is written. An unknown major is a hard
 * error (ADR-0001:132), and an already-current document is returned unchanged,
 * which is what makes `migrate(migrate(doc)) == migrate(doc)` hold
 * (ADR-0006 regression test I).
 */
export function migrateDocument(raw: unknown): MigrationResult {
  const fromVersion = detectSchemaVersion(raw);

  if (fromVersion === null) {
    return {
      success: false,
      fromVersion: null,
      error:
        "Cannot determine architecture document version: expected an object with an integer " +
        "`schemaVersion` (v2+) or a v1 `version` string / `project` block.",
    };
  }

  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    return {
      success: false,
      fromVersion,
      error:
        `Document declares schemaVersion ${fromVersion}, but this build understands ` +
        `up to ${CURRENT_SCHEMA_VERSION}. Refusing to parse a document from the future.`,
    };
  }

  if (fromVersion === CURRENT_SCHEMA_VERSION) {
    return {
      success: true,
      fromVersion,
      data: raw as ArchitectureDocumentV2,
    };
  }

  if (fromVersion !== MIGRATE_FROM_VERSION) {
    return {
      success: false,
      fromVersion,
      error: `No migration registered from schemaVersion ${fromVersion}.`,
    };
  }

  return {
    success: true,
    fromVersion,
    data: migrateV1ToV2(raw as Architecture),
  };
}

/**
 * The migration chain, keyed by the version it migrates *from*. `0004` iterates
 * it in order on read and persists the result only on an explicit write.
 */
export const MIGRATIONS: Record<
  number,
  (document: Architecture) => ArchitectureDocumentV2
> = {
  [MIGRATE_FROM_VERSION]: migrateV1ToV2,
};

/**
 * Edges whose endpoints resolve to nothing, i.e. the preserved dangling
 * references ADR-0001:141-145 asks for. Exported so `0004` can report them
 * rather than silently persisting them.
 */
export function orphanEdges(document: { edges: GraphEdge[] }): GraphEdge[] {
  return document.edges.filter((edge) => edge.dangling === true);
}
