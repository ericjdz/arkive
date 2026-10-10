import { CURRENT_SCHEMA_VERSION } from "../schema/graph.js";
import type { ArchitectureDocumentV2, GraphDecision, GraphEdge, GraphNode, NodeKind } from "../schema/graph.js";
import type { Architecture, ServiceType } from "../schema/types.js";
import { authoredBy } from "../schema/provenance.js";
import { carryUnknownKeys } from "./preserve.js";
import type { ProjectedConnection, ProjectedService } from "./project.js";

/**
 * The v1 authoring surface, and what v2 keeps from v1 on the way in.
 *
 * ADR-0001 deletes `services[]` and `connections[]` as authored fields, and
 * issue 0004 §4 keeps them as a **derived** view so the eight MCP tools, the
 * viewer, the mermaid exporter and the two file-reading skills keep working
 * during the transition. A derived view that is only ever read is not enough:
 * `handleUpdateArchitecture` in `src/server/tools.ts` reads a document, mutates
 * `arch.services`, and writes it back. A write path that ignored that array
 * would report success and change nothing — a silent no-op, the worst thing a
 * persistence layer can do.
 *
 * So the projection is folded back onto the graph and then regenerated. It is
 * derived in the sense that matters: it cannot become an independent source of
 * truth, because every write recomputes it from the graph *after* folding. Two
 * writes of the same graph produce byte-identical projections, and an edit to
 * the stored copy alone is invisible to the next read.
 *
 * ### Migration preserves; authoring validates
 *
 * Different operations, deliberately not treated alike.
 *
 * - **Migration** *preserves* an unresolvable reference as `dangling: true`. A
 *   connection to a service the user has since deleted must survive the upgrade.
 *   Dropping it is the `62066bc` failure class (ADR-0001:141-145).
 * - **Authoring** *rejects* one. A caller naming a node that does not exist has
 *   made a mistake, and the v1 contract already refused it
 *   (`Connection references unknown service "ghost"`). Preserving it would turn
 *   a typo into a dangling edge that every later `reconcile` reports forever.
 */

/** v1 `ServiceType` → v2 `NodeKind`. Lossy in both directions; see ADR-0001. */
const TYPE_TO_KIND = {
  frontend: "service",
  backend: "service",
  database: "datastore",
  cache: "datastore",
  queue: "datastore",
  gateway: "service",
  cdn: "external",
  storage: "datastore",
  auth: "service",
  search: "datastore",
  monitoring: "external",
  other: "service",
} as const satisfies Record<ServiceType, NodeKind>;

export function kindForServiceType(type: ServiceType): NodeKind {
  return TYPE_TO_KIND[type];
}

/**
 * A v1 `Decision` is one carrying `relatedServices` and no `subjects` — which
 * is exactly what `handleRecordDecision` produces today and what a hand-edited
 * v1 document looks like. Translate it rather than reject it.
 *
 * `subjects` is the same information under a name that survives edge deletion,
 * and refusing the write would be refusing to record a decision because the
 * schema changed shape. Dropping it instead would lose the rationale, which is
 * the one thing this product exists to keep.
 */
export function normaliseDecisions(
  decisions: readonly unknown[]
): Array<GraphDecision & { relatedServices: string[] }> {
  return decisions.map((decision) => {
    const record = (isRecord(decision) ? decision : {}) as Record<string, unknown>;
    const subjects = Array.isArray(record.subjects)
      ? (record.subjects as GraphDecision["subjects"])
      : [];
    const related = Array.isArray(record.relatedServices)
      ? record.relatedServices.filter(
          (ref): ref is string => typeof ref === "string" && ref.length > 0
        )
      : [];
    const resolvedSubjects: GraphDecision["subjects"] =
      subjects.length > 0
        ? subjects
        : related.map((ref) => ({ kind: "node" as const, ref }));
    const rest = { ...record };
    delete rest.relatedServices;
    delete rest.subjects;
    return {
      ...rest,
      subjects: resolvedSubjects,
      relatedServices: related,
    } as GraphDecision & { relatedServices: string[] };
  });
}

/**
 * The v1 referential rules, applied to a v1 *edit* over an existing graph.
 *
 * This is the half of `validateArchitecture` that is not a Zod shape check. It
 * is kept rather than delegated because it now guards a different boundary: not
 * "is this a valid v1 document" but "does this edit introduce a reference that
 * resolves to nothing". Those are the rules `update_architecture` was written
 * against, and silently dropping them would let a typo become a permanent
 * dangling edge that every later `reconcile` reports forever.
 *
 * **Preserved dangling edges are exempt.** A connection the user wrote before
 * they deleted a service is history, not a fresh mistake. Refusing to write
 * that document again would make every migrated document with one stale
 * reference permanently unwritable — a far worse outcome than the warning
 * `reconcile` already prints about it.
 */
export function validateV1Authoring(
  graph: ArchitectureDocumentV2,
  services: readonly ProjectedService[],
  connections: readonly ProjectedConnection[]
): string | null {
  const preserved = new Set(
    graph.edges
      .filter((edge) => edge.dangling === true)
      .map((edge) => `${edge.kind}:${edge.from}->${edge.to}:${edge.label ?? edge.kind}`)
  );

  // Nodes this edit is *removing*: present in the graph, absent from the
  // author's `services[]`, and v1-reachable (see `foldV1ViewOntoGraph`). A
  // reference to one of those is the documented cascade (ADR-0001:106-117), not
  // a mistake — the fold drops the edge along with the node, and refusing here
  // would make "delete this service" impossible without also hand-editing every
  // connection it appeared in.
  const wanted = new Set(services.map((service) => service.id));
  const removing = new Set(
    graph.nodes
      .filter(
        (node) =>
          node.deletedAt === undefined &&
          node.legacyType !== undefined &&
          !wanted.has(node.id)
      )
      .map((node) => node.id)
  );

  return validateV1View(
    services,
    connections,
    (connection) =>
      preserved.has(connectionKey(connection)) ||
      removing.has(connection.from) ||
      removing.has(connection.to),
    (service, dependency) => removing.has(dependency)
  );
}

/**
 * The same rules with no exemption, for a document authored from scratch.
 *
 * Nothing here is history, so nothing is excused.
 */
export function validateV1View(
  services: readonly ProjectedService[],
  connections: readonly ProjectedConnection[],
  exemptConnection?: (connection: ProjectedConnection) => boolean,
  exemptDependency?: (service: ProjectedService, dependency: string) => boolean
): string | null {
  const serviceIds = new Set(services.map((service) => service.id));

  for (const connection of connections) {
    if (serviceIds.has(connection.from) && serviceIds.has(connection.to)) continue;
    if (exemptConnection?.(connection)) continue;
    const missing = serviceIds.has(connection.from) ? connection.to : connection.from;
    return `Connection references unknown service "${missing}"`;
  }

  for (const service of services) {
    for (const dependency of service.dependencies) {
      if (serviceIds.has(dependency)) continue;
      if (exemptDependency?.(service, dependency)) continue;
      return `Service "${service.id}" depends on unknown service "${dependency}"`;
    }
  }

  return null;
}

export interface FoldResult {
  graph: ArchitectureDocumentV2;
  /** One entry per tombstoned node, for reporting. */
  removals: Array<{ id: string; droppedEdges: number }>;
}

function edgeKey(kind: string, from: string, to: string, label: string): string {
  return `${kind}:${from}->${to}:${label}`;
}

function connectionKey(connection: ProjectedConnection): string {
  return edgeKey(
    connection.kind ?? "calls",
    connection.from,
    connection.to,
    connection.protocol
  );
}

function uniqueEdgeId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let ordinal = 2;
  while (taken.has(`${base}#${ordinal}`)) ordinal += 1;
  const id = `${base}#${ordinal}`;
  taken.add(id);
  return id;
}

function samePorts(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((port, i) => port === b[i]);
}

/**
 * Fold a v1 `services[]` / `connections[]` edit onto the graph.
 *
 * `graph` is what the caller had; `services` and `connections` are what the
 * caller wants. The difference is applied to the graph.
 *
 * Everything the v1 surface cannot express — a `module` node, a `reads` edge, a
 * `derives_from` edge, a decision — passes through untouched. A deprecated view
 * must not become a lossy filter over the whole graph.
 *
 * Node removal is ADR-0001:106-117: tombstone, drop incident edges, leave every
 * decision and every `subjects` entry alone, and record it in `history`. Nothing
 * is hard-deleted — edges reference nodes, and a decision that pointed at the
 * node must still resolve to a tombstone rather than to nothing.
 */
export function foldV1ViewOntoGraph(
  graph: ArchitectureDocumentV2,
  services: readonly ProjectedService[],
  connections: readonly ProjectedConnection[]
): FoldResult {
  const nodes: GraphNode[] = graph.nodes.map((node) => ({ ...node }));
  const edges: GraphEdge[] = graph.edges.map((edge) => ({ ...edge }));
  const removals: Array<{ id: string; droppedEdges: number }> = [];

  // --- nodes ----------------------------------------------------------------
  const wantedIds = new Set(services.map((service) => service.id));

  for (const node of nodes) {
    if (node.deletedAt !== undefined) continue;
    if (wantedIds.has(node.id)) continue;
    // A node is only removable through the deprecated view if the v1 document
    // could have produced it — that is, if it carries the `legacyType` the
    // migration (or a previous v1 edit) recorded.
    //
    // Without this guard the v1 view would be able to delete the graph it is
    // derived from: a caller who adds a node to `nodes` and forgets the stale
    // `services[]` beside it would have that node silently tombstoned by the
    // next write. A derived view that can delete its own source is the exact
    // "hand-editable derived field is a drift source" failure issue 0004 §4
    // warns about. Nodes authored natively in v2 are graph-native and
    // untouchable from here; removeNode() is the v2 removal path (0005/0008).
    if (node.legacyType === undefined) continue;

    node.deletedAt = new Date().toISOString();
    let dropped = 0;
    for (let i = edges.length - 1; i >= 0; i -= 1) {
      if (edges[i].from === node.id || edges[i].to === node.id) {
        edges.splice(i, 1);
        dropped += 1;
      }
    }
    removals.push({ id: node.id, droppedEdges: dropped });
  }

  for (const service of services) {
    const kind: NodeKind = service.kind ?? kindForServiceType(service.type);
    // `technology` is projected as `tech ?? kind`, so a value equal to the kind
    // carries no information and writing it back would fabricate one.
    const tech =
      service.tech ?? (service.technology === kind ? undefined : service.technology);
    const existing = nodes.find((node) => node.id === service.id);

    if (existing) {
      // Re-adding a tombstoned node revives it rather than creating a second
      // node with the same id, which would fail validation.
      existing.deletedAt = undefined;
      // Record that this node is now v1-reachable, so it can be removed again
      // through the same surface later.
      if (existing.legacyType === undefined) existing.legacyType = service.type;
      if (
        existing.name === service.name &&
        existing.summary === service.description &&
        existing.tech === tech &&
        samePorts(existing.ports, service.ports)
      ) {
        continue;
      }
      existing.name = service.name;
      existing.summary = service.description;
      existing.tech = tech;
      if (service.ports === undefined) delete existing.ports;
      else existing.ports = [...service.ports];
      continue;
    }

    const node: GraphNode = {
      id: service.id,
      kind,
      name: service.name,
      summary: service.description,
      legacyType: service.type,
      provenance: authoredBy("agent"),
    };
    if (tech !== undefined) node.tech = tech;
    if (service.ports !== undefined && service.ports.length > 0) {
      node.ports = [...service.ports];
    }
    nodes.push(node);
  }

  const liveIds = new Set(
    nodes.filter((node) => node.deletedAt === undefined).map((node) => node.id)
  );
  const takenIds = new Set(edges.map((edge) => edge.id));

  // --- dependencies[] is imports edges --------------------------------------
  //
  // Same rule as nodes: an edge is only removable through the deprecated view
  // if the v1 document could have produced it. `legacyEdge` is set by the
  // migration and by this fold; an edge authored natively in v2 carries no
  // marker and is untouchable from here.
  const desiredImports = new Set<string>();
  for (const service of services) {
    for (const dependency of service.dependencies) {
      desiredImports.add(`${service.id}->${dependency}`);
    }
  }

  const satisfiedImports = new Set<string>();
  for (let i = edges.length - 1; i >= 0; i -= 1) {
    const edge = edges[i];
    if (edge.kind !== "imports") continue;
    const key = `${edge.from}->${edge.to}`;
    if (edge.legacyEdge === undefined) continue; // graph-native: leave it alone
    if (desiredImports.has(key) && !satisfiedImports.has(key)) {
      satisfiedImports.add(key);
    } else {
      edges.splice(i, 1);
    }
  }

  for (const key of desiredImports) {
    if (satisfiedImports.has(key)) continue;
    const separator = key.indexOf("->");
    const from = key.slice(0, separator);
    const to = key.slice(separator + 2);
    // An unresolved dependency is rejected by `validateV1Authoring` upstream.
    // Reaching here would mean writing a knowingly broken edge.
    if (!liveIds.has(from) || !liveIds.has(to)) continue;
    edges.push({
      id: uniqueEdgeId(`imports:${from}->${to}`, takenIds),
      from,
      to,
      kind: "imports",
      legacyEdge: true,
      provenance: authoredBy("agent"),
    });
  }

  // --- connections ----------------------------------------------------------
  // Multiset matching rather than a set: two edges between the same pair with
  // the same label and different kinds are two edges, and removing one must not
  // remove the other.
  const wanted = new Map<string, number>();
  for (const connection of connections) {
    const key = connectionKey(connection);
    wanted.set(key, (wanted.get(key) ?? 0) + 1);
  }

  for (let i = edges.length - 1; i >= 0; i -= 1) {
    const edge = edges[i];
    if (edge.kind === "imports" || edge.kind === "decided_by") continue;
    if (edge.legacyEdge === undefined) continue; // graph-native: leave it alone
    const key = edgeKey(edge.kind, edge.from, edge.to, edge.label ?? edge.kind);
    const remaining = wanted.get(key) ?? 0;
    if (remaining > 0) wanted.set(key, remaining - 1);
    else edges.splice(i, 1);
  }

  for (const [key, count] of wanted) {
    if (count === 0) continue;
    const match = /^([a-z_]+):(.+)->([^:]+):([\s\S]*)$/.exec(key);
    if (!match) continue;
    const [, kind, from, to, label] = match;
    if (!liveIds.has(from) || !liveIds.has(to)) continue;
    for (let n = 0; n < count; n += 1) {
      const edge: GraphEdge = {
        id: uniqueEdgeId(`${kind}:${from}->${to}`, takenIds),
        from,
        to,
        kind: kind as GraphEdge["kind"],
        legacyEdge: true,
        provenance: authoredBy("agent"),
      };
      if (label !== "") edge.label = label;
      edges.push(edge);
    }
  }

  // ADR-0001:106-117 — the cascade is recorded. A silent tombstone is a
  // tombstone nobody ever cleans up.
  let history = graph.history;
  if (removals.length > 0) {
    const now = new Date().toISOString();
    const summary = removals
      .map((removal) =>
        removal.droppedEdges === 1
          ? `${removal.id} (1 edge dropped)`
          : `${removal.id} (${removal.droppedEdges} edges dropped)`
      )
      .join(", ");
    history = [
      ...history,
      {
        timestamp: now,
        action: "remove_node",
        summary:
          `Removed ${removals.length} node(s): ${summary}. ` +
          `Decisions and their subjects were left untouched.`,
      },
    ];
  }

  return {
    graph: { ...graph, schemaVersion: CURRENT_SCHEMA_VERSION, nodes, edges, history },
    removals,
  };
}

/**
 * Carry the v1 fields v2 has no home for onto the elements they came from.
 *
 * `type` → `node.legacyType`, and `source` / `confidence` → `node.source` /
 * `node.confidence` and the same pair on each migrated edge. All handled the
 * same way — kept verbatim, read by nothing semantic, invisible to every
 * traversal:
 *
 * - `type`. ADR-0001 deletes the deployment taxonomy as a *semantic* field:
 *   nothing reads it to answer a structural question. That is not a claim the
 *   user's value is worthless, and a migration that discards it is a lossy
 *   migration. It exists for one reason: to make the `services[]` projection
 *   round-trip a v1 document.
 * - `source` / `confidence`. ADR-0002 deletes both as inert — written by no
 *   code path. But `src/analysis/drift.ts` reads `confidence` to raise a
 *   low-confidence warning, and dropping it on migration would silently
 *   *reduce* the warnings a migrated document emits. A drift detector that goes
 *   quiet is worse than one that nags.
 */
export function carryLegacyServiceFields(
  v1: Architecture,
  graph: ArchitectureDocumentV2
): ArchitectureDocumentV2 {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  for (const service of v1.services) {
    const node = byId.get(service.id);
    if (!node) continue;
    if (typeof service.type === "string") node.legacyType = service.type;
    if (service.source !== undefined) node.source = service.source;
    if (service.confidence !== undefined) node.confidence = service.confidence;
  }

  // `migrateV1ToV2` emits every `imports` edge first (grouped by service, in
  // `dependencies` order), then every `calls` edge in `connections` order.
  const importEdges = graph.edges.filter((edge) => edge.kind === "imports");
  const callsEdges = graph.edges.filter((edge) => edge.kind === "calls");

  v1.services.forEach((service) => {
    for (const dependency of service.dependencies) {
      const edge = importEdges.find(
        (candidate) => candidate.from === service.id && candidate.to === dependency
      );
      if (edge) edge.legacyEdge = true;
    }
  });

  // Connections land on the `calls` edges, in order.
  v1.connections.forEach((connection, index) => {
    const edge = callsEdges[index];
    if (!edge) return;
    if (connection.source !== undefined) edge.source = connection.source;
    if (connection.confidence !== undefined) edge.confidence = connection.confidence;
    // See `foldV1ViewOntoGraph`: a `legacyEdge` is one the deprecated view is
    // allowed to delete. An edge authored natively in v2 is not.
    edge.legacyEdge = true;
  });

  return graph;
}

/**
 * Move every key the v1 schema did not recognise onto the migrated element it
 * came from.
 *
 * Without this, migrating a document silently deletes the user's own fields —
 * the exact class ADR-0006 §3 exists to close, reintroduced by the migration
 * itself. `migrateV1ToV2` is a *semantic* transform: it reads named fields off
 * a v1 document and builds a fresh v2 one, so anything unnamed falls on the
 * floor.
 *
 * The positional mapping below is not incidental — it is exactly the order
 * `migrateV1ToV2` emits in, and it is the only thing that makes an unknown key
 * on `connections[3]` land on the right edge rather than on the wrong one.
 */
export function carryV1UnknownKeys(
  v1Raw: unknown,
  v1Zod: unknown,
  graph: ArchitectureDocumentV2
): ArchitectureDocumentV2 {
  if (!isRecord(v1Raw) || !isRecord(v1Zod)) return graph;

  // Document level, `project`, `stack` — same names on both sides.
  carryUnknownKeys(v1Raw, v1Zod, graph, MIGRATED_KEYS);
  if (isRecord(v1Raw.project) && isRecord(v1Zod.project)) {
    carryUnknownKeys(v1Raw.project, v1Zod.project, graph.project);
  }
  if (isRecord(v1Raw.stack) && isRecord(v1Zod.stack)) {
    carryUnknownKeys(v1Raw.stack, v1Zod.stack, graph.stack);
  }

  // `migrateV1ToV2` emits nodes in `services` order, then every `imports` edge
  // (grouped by service, in `dependencies` order), then every `calls` edge in
  // `connections` order. That ordering is the whole reason the unknown key on
  // `connections[3]` can be put back on the right edge.
  const v1Services = arrayOfRecords(v1Raw.services);
  const v1ServicesZod = arrayOfRecords(v1Zod.services);
  graph.nodes.forEach((node, index) => {
    carryUnknownKeys(v1Services[index], v1ServicesZod[index], node);
  });

  const importCount = v1Services
    .flatMap((service) => arrayOfRecords(service?.dependencies))
    .length;
  const v1Connections = arrayOfRecords(v1Raw.connections);
  const v1ConnectionsZod = arrayOfRecords(v1Zod.connections);
  v1Connections.forEach((connection, index) => {
    carryUnknownKeys(
      connection,
      v1ConnectionsZod[index],
      graph.edges[importCount + index]
    );
  });

  const v1Decisions = arrayOfRecords(v1Raw.decisions);
  const v1DecisionsZod = arrayOfRecords(v1Zod.decisions);
  v1Decisions.forEach((decision, index) => {
    const target = graph.decisions[index];
    if (!decision || !target) return;
    carryUnknownKeys(decision, v1DecisionsZod[index], target);
    const alternatives = arrayOfRecords(decision.alternatives);
    const alternativesZod = arrayOfRecords(v1DecisionsZod[index]?.alternatives);
    alternatives.forEach((alternative, altIndex) => {
      if (!alternative) return;
      carryUnknownKeys(alternative, alternativesZod[altIndex], target.alternatives[altIndex]);
    });
  });

  const v1Flows = arrayOfRecords(v1Raw.dataFlows);
  const v1FlowsZod = arrayOfRecords(v1Zod.dataFlows);
  v1Flows.forEach((flow, index) => {
    const target = graph.dataFlows[index];
    if (!flow || !target) return;
    carryUnknownKeys(flow, v1FlowsZod[index], target);
    const steps = arrayOfRecords(flow.steps);
    const stepsZod = arrayOfRecords(v1FlowsZod[index]?.steps);
    steps.forEach((step, stepIndex) => {
      if (!step) return;
      carryUnknownKeys(step, stepsZod[stepIndex], target.steps[stepIndex]);
    });
  });

  const v1History = arrayOfRecords(v1Raw.history);
  const v1HistoryZod = arrayOfRecords(v1Zod.history);
  v1History.forEach((entry, index) => {
    carryUnknownKeys(entry, v1HistoryZod[index], graph.history[index]);
  });

  return graph;
}

/** Top-level keys the migration owns; everything else is the user's. */
const MIGRATED_KEYS: ReadonlySet<string> = new Set([
  "version",
  "project",
  "stack",
  "services",
  "connections",
  "decisions",
  "dataFlows",
  "history",
  "schemaVersion",
  "nodes",
  "edges",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown> | undefined> {
  return Array.isArray(value)
    ? value.map((item) => (isRecord(item) ? item : undefined))
    : [];
}