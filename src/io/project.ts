import type { ArchitectureDocumentV2, GraphEdge, GraphNode, NodeKind } from "../schema/graph.js";
import type { Connection, Service, ServiceType } from "../schema/types.js";

/**
 * The deprecated v1 view, computed from the graph.
 *
 * ADR-0001 deletes `services[]` and `connections[]` as *authored* fields and
 * replaces them with a pure function of the graph. This module is that
 * function, and it is the only place in the codebase allowed to produce the v1
 * shape.
 *
 * **The projection is never an input.** `readArchitecture` computes it on the
 * way out; `writeArchitecture` folds it back onto the graph and recomputes it on
 * the way in. What lands on disk is always derived from the graph it ships
 * with. `docs/decisions/services-projection.md` records why the field is
 * persisted at all, and when it is deleted.
 *
 * ### What the projection loses, stated plainly
 *
 * - `Service.type` does not survive v2 as a *semantic* field. ADR-0001 deletes
 *   the deployment taxonomy because it overlaps `kind` and answers none of the
 *   structural questions, so there is nothing to project back. The projected
 *   service carries the real answer in `kind`; `type` is filled with the v1
 *   label the node was authored with (`legacyType`), or the nearest synonym of
 *   its kind when there is none.
 * - `Service.technology` is `node.tech`, falling back to `node.kind` when the
 *   node never recorded one. Empty would fail `ServiceSchema` (`min(1)`), and
 *   inventing a technology is worse than reporting the kind. The raw value is
 *   kept on `tech` so the fold-back can tell the two apart.
 * - `Connection.protocol` is `edge.label`, falling back to `edge.kind`.
 * - `Decision.relatedServices` is the `kind: "node"` subjects. `kind: "edge"`
 *   subjects have no v1 representation; `reconcile` reports them rather than
 *   this module dropping them.
 * - `source` / `confidence` are gone (ADR-0002 deletes both). The projection
 *   cannot invent them, and a fabricated `confidence: 1.0` would be a lie that
 *   `drift.ts` then treats as evidence.
 *
 * None of that loses information the graph still records. Everything the
 * projection does drop is dropped only from the *view*.
 */

/** The only two v1 labels that are synonyms rather than guesses.
 *
 *  A `datastore` really was a `database` service, and an `endpoint` on a
 *  datastore is what a v1 document called a `gateway`. Everything else is
 *  `other`: a `service` node is not necessarily a backend, and saying so would
 *  be a fabrication of exactly the kind `migrateV1ToV2` avoids by marking
 *  migrated elements `authoredBy: "agent"` rather than `derived`.
 */
const KIND_TO_SERVICE_TYPE = {
  service: "other",
  datastore: "database",
  endpoint: "gateway",
  external: "other",
  module: "other",
  datastructure: "other",
} satisfies Record<NodeKind, ServiceType>;

/** A projected service: the v1 shape, plus the v2 fields it cannot express. */
export interface ProjectedService extends Service {
  /**
   * The v2 node kind. `Service.type` is a taxonomy v2 deleted, so this is where
   * the real answer lives.
   *
   * Optional on the way *in*: `update_architecture` sends `ServiceSchema`, which
   * has no `kind`, and `foldV1ViewOntoGraph` falls back to the v1 `type`. The
   * projection always sets it on the way out.
   */
  kind?: NodeKind;
  /** The node's real `tech`, or undefined. Distinguishes "" from "never set". */
  tech?: string;
}

/** A projected connection: the v1 shape, plus the v2 edge kind and label. */
export interface ProjectedConnection extends Connection {
  /**
   * The v2 edge kind. Optional on the way in, for the same reason `kind` is on
   * `ProjectedService`: a v1 author writes `protocol` and nothing else, and the
   * fold treats a missing kind as `calls` (ADR-0001:141-142).
   */
  kind?: GraphEdge["kind"];
  /** The edge's real `label`, or undefined. Distinguishes "" from "never set". */
  label?: string;
}

/**
 * The v1 `type` for a node.
 *
 * A node migrated from v1 carries `legacyType` — the value the user actually
 * wrote, kept verbatim by `carryLegacyServiceFields` so the migration is not
 * lossy. It is used here for one reason: to make the projection round-trip.
 * Nothing traverses on it and no structural question is answered by it.
 */
function serviceTypeFor(node: GraphNode): ServiceType {
  return isServiceType(node.legacyType)
    ? node.legacyType
    : KIND_TO_SERVICE_TYPE[node.kind];
}

function isServiceType(value: unknown): value is ServiceType {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SERVICE_TYPES, value)
  );
}

const SERVICE_TYPES: Record<ServiceType, true> = {
  frontend: true,
  backend: true,
  database: true,
  cache: true,
  queue: true,
  gateway: true,
  cdn: true,
  storage: true,
  auth: true,
  search: true,
  monitoring: true,
  other: true,
};

/**
 * Fields the projection owns, so anything else on a node or edge is the user's
 * and is carried across untouched.
 *
 * Without this, `read → write` through the deprecated view would delete every
 * hand-added key that was sitting on the stored `services[]` / `connections[]`
 * copy — which is precisely the regression ADR-0006 §3 exists to close, reached
 * by a different route.
 */
const NODE_PROJECTION_KEYS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "type",
  "technology",
  "description",
  "dependencies",
  "ports",
  "kind",
  "tech",
  "deletedAt",
  "provenance",
]);

const EDGE_PROJECTION_KEYS: ReadonlySet<string> = new Set([
  "id",
  "from",
  "to",
  "kind",
  "label",
  "note",
  "dangling",
  "provenance",
]);

function carryUserKeys(
  source: Record<string, unknown>,
  into: Record<string, unknown>,
  owned: ReadonlySet<string>
): void {
  for (const [key, value] of Object.entries(source)) {
    if (owned.has(key)) continue;
    into[key] = value;
  }
}

/** `imports` edges become `Service.dependencies[]`, not connections. */
function isDependencyEdge(kind: string): boolean {
  return kind === "imports";
}

/**
 * Every live node becomes a `services[]` entry, including `module`.
 *
 * Not a nicety. A v1 consumer's `services[]` is the only way `0005`-era code
 * sees a module, and a projection that filtered node kinds would make every
 * module invisible to the viewer, the mermaid exporter and
 * `architecture-tracker` while they are exactly the structure those consumers
 * most need to show.
 *
 * Tombstoned nodes are excluded, and that is the *only* filtering here. It is
 * safe because `foldV1ViewOntoGraph` will never tombstone a node on the
 * strength of this projection alone — it only removes nodes the v1 document
 * could have produced (`legacyType`) — so a derived `module` node cannot be
 * read as a deletion.
 */
function liveNodes(graph: { nodes: GraphNode[] }): GraphNode[] {
  return graph.nodes.filter((node) => node.deletedAt === undefined);
}

export function projectServices(graph: {
  nodes: GraphNode[];
  edges: GraphEdge[];
}): ProjectedService[] {
  const nodes = liveNodes(graph);
  const ids = new Set(nodes.map((node) => node.id));

  return nodes.map((node) => {
    const dependencies = graph.edges
      .filter(
        (edge) =>
          isDependencyEdge(edge.kind) &&
          edge.from === node.id &&
          edge.dangling !== true &&
          ids.has(edge.to)
      )
      .map((edge) => edge.to);

    const projected: ProjectedService = {
      id: node.id,
      name: node.name,
      type: serviceTypeFor(node),
      technology: node.tech ?? node.kind,
      description: node.summary,
      dependencies,
      kind: node.kind,
      ...(node.ports === undefined ? {} : { ports: [...node.ports] }),
      ...(node.tech === undefined ? {} : { tech: node.tech }),
    };
    carryUserKeys(
      node as unknown as Record<string, unknown>,
      projected as unknown as Record<string, unknown>,
      NODE_PROJECTION_KEYS
    );
    return projected;
  });
}

export function projectConnections(graph: { edges: GraphEdge[] }): ProjectedConnection[] {
  return graph.edges
    .filter((edge) => edge.kind !== "decided_by" && !isDependencyEdge(edge.kind))
    .map((edge) => {
      const projected: ProjectedConnection = {
        from: edge.from,
        to: edge.to,
        protocol: edge.label ?? edge.kind,
        description: edge.note ?? "",
        kind: edge.kind,
        ...(edge.label === undefined ? {} : { label: edge.label }),
      };
      carryUserKeys(
        edge as unknown as Record<string, unknown>,
        projected as unknown as Record<string, unknown>,
        EDGE_PROJECTION_KEYS
      );
      return projected;
    });
}

/**
 * `Decision.relatedServices` from `subjects`.
 *
 * `kind: "edge"` subjects are deliberately absent: v1 has no way to say "this
 * decision explains an edge", and inventing one would create a reference that
 * resolves against nothing.
 */
export function projectDecisionSubjects(
  subjects: ReadonlyArray<{ kind: "node" | "edge"; ref: string }>
): string[] {
  return subjects.filter((subject) => subject.kind === "node").map((subject) => subject.ref);
}

export interface ProjectedDocument {
  services: ProjectedService[];
  connections: ProjectedConnection[];
}

/**
 * Every deprecated top-level array, computed in one pass.
 *
 * One entry point so `readArchitecture` and `writeArchitecture` cannot
 * disagree about what the projection is.
 */
export function projectDocument(graph: {
  nodes: GraphNode[];
  edges: GraphEdge[];
}): ProjectedDocument {
  return {
    services: projectServices(graph),
    connections: projectConnections(graph),
  };
}