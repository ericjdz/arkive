import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  StorableEdgeKind,
} from "../schema/graph.js";
import {
  GraphIndex,
  caveatsFor,
  evidenceFor,
  gateFor,
  isObservation,
  whyDoesThisExist,
  type ClaimGate,
  type GraphSlice,
} from "../io/decisions.js";
import {
  STORABLE_EDGE_KINDS,
  SYSTEM_ROOT,
  childNodes,
  claimForEdge,
  claimForNode,
  descendBreadcrumb,
  directDecisions,
  decisionEntryFor,
  edgeEntry,
  emptyEdgeGroups,
  nodeEntry,
  type AlternativeView,
  type Breadcrumb,
  type DecisionEntry,
  type EdgeEntry,
  type NodeEntry,
  type ProvenanceClaim,
  type WalkLevel,
} from "./levels.js";

/**
 * Traversal primitives and named traversals (issue 0009, ADR-0003).
 *
 * Three primitives, each a pure query over the graph:
 * - `topology()` — every node and edge with no prose ("what is this system").
 * - `open()` — one node or edge opened into inbound/outbound edges by kind,
 *   module children, data shapes, and `decided_by` decisions.
 * - `trace()` — a directed path annotated with the edge kind at each hop.
 *
 * Four named traversals built on the primitives: `traceRequest`,
 * `explainBoundary`, `explainDecision`, `followDataShape`. Plus level
 * navigation: `viewAtLevel` and `ascend`.
 *
 * No I/O, no LLM calls, deterministic: ties break by id, everywhere.
 */

export const DEFAULT_OPEN_DEPTH = 1;
export const MAX_OPEN_DEPTH = 3;

/** Edge kinds a request can travel at runtime (structural kinds excluded). */
const RUNTIME_EDGE_KINDS = ["calls", "reads", "writes"] as const;

/** Clamp a requested depth to [1, 3]; non-numbers fall back to the default. */
export function clampDepth(depth: number | undefined): number {
  if (typeof depth !== "number" || !Number.isFinite(depth)) return DEFAULT_OPEN_DEPTH;
  return Math.min(MAX_OPEN_DEPTH, Math.max(1, Math.floor(depth)));
}

// ---------------------------------------------------------------------------
// topology()
// ---------------------------------------------------------------------------

export interface CompactNode {
  id: string;
  kind: GraphNode["kind"];
  name: string;
  live: boolean;
  provenance: ProvenanceClaim;
}

export interface CompactEdge {
  id: string;
  kind: GraphEdge["kind"];
  from: string;
  to: string;
  provenance: ProvenanceClaim;
}

export interface TopologyResult {
  nodes: CompactNode[];
  edges: CompactEdge[];
  counts: {
    nodes: number;
    edges: number;
    live: number;
    tombstoned: number;
    byNodeKind: Partial<Record<GraphNode["kind"], number>>;
    byEdgeKind: Partial<Record<GraphEdge["kind"], number>>;
  };
  notes: string[];
}

/**
 * Every node and edge with no prose: names, kinds, directions. The
 * System-level answer to "what is this". Tombstoned nodes are included and
 * marked, never silently dropped.
 */
export function topology(graph: GraphSlice): TopologyResult {
  const index = new GraphIndex(graph);
  const nodes: CompactNode[] = graph.nodes
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((node) => ({
      id: node.id,
      kind: node.kind,
      name: node.name,
      live: node.deletedAt === undefined,
      provenance: claimForNode(index, node),
    }));
  const edges: CompactEdge[] = graph.edges
    .filter((edge) => edge.kind !== "decided_by")
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((edge) => ({
      id: edge.id,
      kind: edge.kind,
      from: edge.from,
      to: edge.to,
      provenance: claimForEdge(index, edge),
    }));

  const byNodeKind: Partial<Record<GraphNode["kind"], number>> = {};
  for (const node of nodes) byNodeKind[node.kind] = (byNodeKind[node.kind] ?? 0) + 1;
  const byEdgeKind: Partial<Record<GraphEdge["kind"], number>> = {};
  for (const edge of edges) byEdgeKind[edge.kind] = (byEdgeKind[edge.kind] ?? 0) + 1;

  return {
    nodes,
    edges,
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      live: nodes.filter((node) => node.live).length,
      tombstoned: nodes.filter((node) => !node.live).length,
      byNodeKind,
      byEdgeKind,
    },
    notes: [
      "Topology carries names, kinds, and directions only — no summaries, no paths. " +
        "Open a ref for detail, at the level that matches the question.",
    ],
  };
}

// ---------------------------------------------------------------------------
// open()
// ---------------------------------------------------------------------------

export interface OpenOptions {
  depth?: number;
  level?: WalkLevel;
  breadcrumb?: Breadcrumb;
}

export type OpenResult =
  | {
      found: true;
      ref: string;
      subjectKind: "node" | "edge";
      level: WalkLevel;
      /** The clamped depth this result was expanded to. */
      depth: number;
      breadcrumb: Breadcrumb;
      subject: NodeEntry | EdgeEntry;
      inbound: Record<StorableEdgeKind, EdgeEntry[]>;
      outbound: Record<StorableEdgeKind, EdgeEntry[]>;
      children: NodeEntry[];
      dataShapes: NodeEntry[];
      decisions: DecisionEntry[];
      /** Every node within `depth` hops (undirected, over stored edges). */
      neighborhood: { nodes: NodeEntry[]; edges: EdgeEntry[] };
      provenance: ProvenanceClaim;
      notes: string[];
    }
  | {
      found: false;
      ref: string;
      level: WalkLevel;
      depth: number;
      breadcrumb: Breadcrumb;
      notes: string[];
    };

function isStorableKind(kind: EdgeKind): kind is StorableEdgeKind {
  return (STORABLE_EDGE_KINDS as readonly string[]).includes(kind);
}

function groupEdges(
  index: GraphIndex,
  graph: GraphSlice,
  edges: GraphEdge[]
): Record<StorableEdgeKind, EdgeEntry[]> {
  const groups = emptyEdgeGroups();
  const ordered = edges.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const edge of ordered) {
    if (!isStorableKind(edge.kind)) continue;
    groups[edge.kind].push(edgeEntry(index, graph, edge));
  }
  return groups;
}

function neighborhood(
  index: GraphIndex,
  graph: GraphSlice,
  level: WalkLevel,
  startId: string,
  depth: number
): { nodes: NodeEntry[]; edges: EdgeEntry[] } {
  const adjacency = new Map<string, GraphEdge[]>();
  const stored = graph.edges.filter((edge) => isStorableKind(edge.kind));
  for (const edge of stored) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from)?.push(edge);
    adjacency.get(edge.to)?.push(edge);
  }
  for (const list of adjacency.values()) {
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  const seen = new Set<string>([startId]);
  let frontier = [startId];
  for (let hop = 0; hop < depth; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of adjacency.get(id) ?? []) {
        const other = edge.from === id ? edge.to : edge.from;
        if (!seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodes: NodeEntry[] = [...seen]
    .sort()
    .map((id) => byId.get(id))
    .filter((node): node is GraphNode => node !== undefined)
    .map((node) => nodeEntry(index, node, level));
  const edges: EdgeEntry[] = stored
    .filter((edge) => seen.has(edge.from) && seen.has(edge.to))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((edge) => edgeEntry(index, graph, edge));
  return { nodes, edges };
}

/**
 * Open one node or edge into what it contains: inbound and outbound edges
 * grouped by kind, module children (path containment), data shapes
 * (datastructure neighbours within one hop over derives_from/reads/writes),
 * and `decided_by` decisions via the `projectDecidedBy` join.
 *
 * Depth caps the neighbourhood expansion (default 1, max 3). The result
 * carries a breadcrumb so a caller can move up without losing place.
 */
export function open(
  graph: GraphSlice,
  ref: string,
  depthOrOptions?: number | OpenOptions
): OpenResult {
  const options: OpenOptions =
    typeof depthOrOptions === "number" ? { depth: depthOrOptions } : (depthOrOptions ?? {});
  const level: WalkLevel = options.level ?? "subsystem";
  const requested = options.depth;
  const depth = clampDepth(requested);
  const breadcrumb = descendBreadcrumb(options.breadcrumb, ref);
  const index = new GraphIndex(graph);

  const node = graph.nodes.find((candidate) => candidate.id === ref);
  const edge = node === undefined ? graph.edges.find((candidate) => candidate.id === ref) : undefined;
  if (node === undefined && edge === undefined) {
    return {
      found: false,
      ref,
      level,
      depth,
      breadcrumb,
      notes: [
        `No node or edge "${ref}" exists in this graph. A decision explaining it, if one ` +
          `was ever recorded, still names it — check the document's decisions directly.`,
      ],
    };
  }

  const notes: string[] = [];
  if (requested !== undefined && depth !== Math.floor(requested)) {
    notes.push(`Depth ${Math.floor(requested)} exceeds the maximum of ${MAX_OPEN_DEPTH}; clamped to ${depth}.`);
  }

  const stored = graph.edges.filter((candidate) => isStorableKind(candidate.kind));
  const subjectKind = node !== undefined ? "node" : "edge";
  const subject =
    node !== undefined ? nodeEntry(index, node, level) : edgeEntry(index, graph, edge!);
  const provenance =
    node !== undefined ? claimForNode(index, node) : claimForEdge(index, edge!);

  const inbound = groupEdges(
    index,
    graph,
    stored.filter((candidate) => candidate.to === ref)
  );
  const outbound = groupEdges(
    index,
    graph,
    stored.filter((candidate) => candidate.from === ref)
  );

  const children =
    node !== undefined
      ? childNodes(graph, node).map((child) => nodeEntry(index, child, level))
      : [];

  const shapeIds = new Set<string>();
  for (const candidate of stored) {
    if (candidate.kind !== "derives_from" && candidate.kind !== "reads" && candidate.kind !== "writes") {
      continue;
    }
    if (candidate.from === ref || candidate.to === ref) {
      const other = candidate.from === ref ? candidate.to : candidate.from;
      if (other !== ref) {
        const otherNode = graph.nodes.find((n) => n.id === other);
        if (otherNode?.kind === "datastructure") shapeIds.add(other);
      }
    }
  }
  const dataShapes = [...shapeIds]
    .sort()
    .map((id) => graph.nodes.find((n) => n.id === id))
    .filter((n): n is GraphNode => n !== undefined)
    .map((shape) => nodeEntry(index, shape, level));

  const decisions = directDecisions(graph, index, ref);

  if (node !== undefined && node.deletedAt !== undefined) {
    notes.push(
      `Node "${node.id}" was removed at ${node.deletedAt}. Its decisions are intact ` +
        `by design — removal is a tombstone, never a hard delete. The decided_by ` +
        `projection below is empty because the link is not live; use explainDecision ` +
        `for the surviving rationale.`
    );
  }
  if (decisions.length === 0 && (node === undefined || node.deletedAt === undefined)) {
    notes.push(
      `No decision projects a decided_by edge onto "${ref}". Absence of a recorded ` +
        `reason is not evidence that there was none — explainDecision also checks ` +
        `inherited and incident rationale.`
    );
  }

  return {
    found: true,
    ref,
    subjectKind,
    level,
    depth,
    breadcrumb,
    subject,
    inbound,
    outbound,
    children,
    dataShapes,
    decisions,
    neighborhood: neighborhood(index, graph, level, ref, depth),
    provenance,
    notes,
  };
}

// ---------------------------------------------------------------------------
// trace()
// ---------------------------------------------------------------------------

export interface TraceHop {
  from: string;
  to: string;
  /** Id of the real edge this hop travels. */
  via: string;
  kind: StorableEdgeKind;
}

export type TraceResult =
  | {
      found: true;
      entryRef: string;
      exitRef: string;
      nodes: CompactNode[];
      edges: CompactEdge[];
      hops: TraceHop[];
      notes: string[];
    }
  | {
      found: false;
      entryRef: string;
      exitRef: string;
      reason: string;
      notes: string[];
    };

function liveById(graph: GraphSlice): Map<string, GraphNode> {
  return new Map(
    graph.nodes
      .filter((node) => node.deletedAt === undefined)
      .map((node) => [node.id, node])
  );
}

function bfs(
  graph: GraphSlice,
  index: GraphIndex,
  entryRef: string,
  exitRef: string,
  kinds: readonly StorableEdgeKind[]
): TraceResult {
  const live = liveById(graph);
  const allowed = new Set<string>(kinds);
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    if (!isStorableKind(edge.kind) || !allowed.has(edge.kind)) continue;
    if (!live.has(edge.from) || !live.has(edge.to)) continue;
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from)?.push(edge);
  }
  for (const list of outgoing.values()) {
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  if (!live.has(entryRef)) {
    return {
      found: false,
      entryRef,
      exitRef,
      reason:
        entryRef === exitRef
          ? `"${entryRef}" does not resolve to a live node.`
          : `"${entryRef}" does not resolve to a live node, so no path can start there.`,
      notes: ["Trace walks live nodes only; tombstoned nodes are gone, not traversable."],
    };
  }
  if (!live.has(exitRef)) {
    return {
      found: false,
      entryRef,
      exitRef,
      reason: `"${exitRef}" does not resolve to a live node, so no path can end there.`,
      notes: ["Trace walks live nodes only; tombstoned nodes are gone, not traversable."],
    };
  }
  if (entryRef === exitRef) {
    const node = live.get(entryRef)!;
    return {
      found: true,
      entryRef,
      exitRef,
      nodes: [
        {
          id: node.id,
          kind: node.kind,
          name: node.name,
          live: true,
          provenance: claimForNode(index, node),
        },
      ],
      edges: [],
      hops: [],
      notes: ["Entry and exit are the same node: a zero-hop path."],
    };
  }

  const parent = new Map<string, GraphEdge>();
  const visited = new Set<string>([entryRef]);
  const queue: string[] = [entryRef];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of outgoing.get(current) ?? []) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      parent.set(edge.to, edge);
      if (edge.to === exitRef) {
        queue.length = 0;
        break;
      }
      queue.push(edge.to);
    }
  }

  if (!parent.has(exitRef)) {
    return {
      found: false,
      entryRef,
      exitRef,
      reason: `No directed path from "${entryRef}" to "${exitRef}" over ${kinds.join(", ")} edges.`,
      notes: ["No path is reported as found:false — never an invented one."],
    };
  }

  const pathEdges: GraphEdge[] = [];
  let cursor = exitRef;
  while (cursor !== entryRef) {
    const edge = parent.get(cursor)!;
    pathEdges.unshift(edge);
    cursor = edge.from;
  }
  const nodeIds = [entryRef, ...pathEdges.map((edge) => edge.to)];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return {
    found: true,
    entryRef,
    exitRef,
    nodes: nodeIds.map((id) => {
      const n = byId.get(id)!;
      return {
        id: n.id,
        kind: n.kind,
        name: n.name,
        live: n.deletedAt === undefined,
        provenance: claimForNode(index, n),
      };
    }),
    edges: pathEdges.map((edge) => ({
      id: edge.id,
      kind: edge.kind,
      from: edge.from,
      to: edge.to,
      provenance: claimForEdge(index, edge),
    })),
    hops: pathEdges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      via: edge.id,
      kind: edge.kind as StorableEdgeKind,
    })),
    notes: [`Shortest directed path: ${pathEdges.length} hop(s) by breadth-first search.`],
  };
}

/**
 * Shortest directed path through calls/reads/writes/imports/derives_from
 * edges, annotated with the edge kind at each hop. No path is an explicit
 * `{ found: false }` result, never an invented path.
 */
export function trace(graph: GraphSlice, entryRef: string, exitRef: string): TraceResult {
  return bfs(graph, new GraphIndex(graph), entryRef, exitRef, STORABLE_EDGE_KINDS);
}

// ---------------------------------------------------------------------------
// traceRequest()
// ---------------------------------------------------------------------------

export interface RequestHop extends TraceHop {
  action: "invoke" | "read" | "write";
}

export type TraceRequestResult =
  | {
      found: true;
      entryRef: string;
      exitRef: string;
      runtimeOnly: true;
      nodes: CompactNode[];
      edges: CompactEdge[];
      hops: RequestHop[];
      notes: string[];
    }
  | {
      found: false;
      entryRef: string;
      exitRef: string;
      runtimeOnly: true;
      reason: string;
      notes: string[];
    };

const ACTION_FOR_KIND: Record<(typeof RUNTIME_EDGE_KINDS)[number], RequestHop["action"]> = {
  calls: "invoke",
  reads: "read",
  writes: "write",
};

/**
 * A request or event traced end to end over runtime edges only
 * (calls/reads/writes). Structural edges (imports, derives_from) can connect
 * two nodes without anything ever flowing between them at runtime, so a
 * request path that used them would be a static guess dressed as behaviour.
 */
export function traceRequest(
  graph: GraphSlice,
  entryRef: string,
  exitRef: string
): TraceRequestResult {
  const result = bfs(graph, new GraphIndex(graph), entryRef, exitRef, RUNTIME_EDGE_KINDS);
  if (!result.found) return { ...result, runtimeOnly: true as const };
  return {
    ...result,
    runtimeOnly: true as const,
    hops: result.hops.map((hop) => ({
      ...hop,
      action: ACTION_FOR_KIND[hop.kind as keyof typeof ACTION_FOR_KIND],
    })),
    notes: [
      ...result.notes,
      "Runtime edges only (calls/reads/writes): imports and derives_from are structure, not flow.",
    ],
  };
}

// ---------------------------------------------------------------------------
// explainBoundary()
// ---------------------------------------------------------------------------

export type BoundaryExplanation =
  | {
      found: true;
      ref: string;
      name: string;
      kind: GraphNode["kind"];
      level: WalkLevel;
      breadcrumb: Breadcrumb;
      children: NodeEntry[];
      inboundByKind: Record<StorableEdgeKind, EdgeEntry[]>;
      outboundByKind: Record<StorableEdgeKind, EdgeEntry[]>;
      /** Edges with exactly one endpoint inside the boundary. */
      crossingEdges: EdgeEntry[];
      decisions: DecisionEntry[];
      provenance: ProvenanceClaim;
      notes: string[];
    }
  | {
      found: false;
      ref: string;
      notes: string[];
    };

/**
 * Why these modules are grouped: the children, the inbound and outbound
 * edges by kind, the edges that cross the boundary, and the decisions that
 * shaped it. Built on `open()` at subsystem level.
 */
export function explainBoundary(graph: GraphSlice, ref: string): BoundaryExplanation {
  const opened = open(graph, ref, { level: "subsystem" });
  if (!opened.found) return { found: false, ref, notes: opened.notes };
  if (opened.subjectKind !== "node" || opened.subject.kind !== "node") {
    return {
      found: false,
      ref,
      notes: [`"${ref}" is an edge, not a boundary. Boundaries are nodes.`],
    };
  }
  const index = new GraphIndex(graph);
  const inside = new Set<string>([ref, ...opened.children.map((child) => child.id)]);
  const crossingEdges = graph.edges
    .filter((edge) => isStorableKind(edge.kind))
    .filter(
      (edge) =>
        (inside.has(edge.from) && !inside.has(edge.to)) ||
        (inside.has(edge.to) && !inside.has(edge.from))
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((edge) => edgeEntry(index, graph, edge));

  const node = graph.nodes.find((candidate) => candidate.id === ref)!;
  const notes = [...opened.notes];
  notes.push(
    node.path !== undefined
      ? `"${node.name}" groups ${opened.children.length} module(s) by path containment under "${node.path}".`
      : `"${node.name}" declares no path, so its grouping is nominal — the children above ` +
          `are empty and the boundary rests on edges and decisions alone.`
  );

  return {
    found: true,
    ref,
    name: node.name,
    kind: node.kind,
    level: "subsystem",
    breadcrumb: opened.breadcrumb,
    children: opened.children,
    inboundByKind: opened.inbound,
    outboundByKind: opened.outbound,
    crossingEdges,
    decisions: opened.decisions,
    provenance: opened.provenance,
    notes,
  };
}

// ---------------------------------------------------------------------------
// explainDecision()
// ---------------------------------------------------------------------------

export interface DecisionClaimView {
  decisionId: string;
  topic: string;
  decision: string;
  rationale: string;
  timestamp: string;
  rejectedAlternatives: AlternativeView[];
  /** The full alternative list, verbatim — always included. */
  alternatives: AlternativeView[];
  observation: boolean;
  subject: DecisionClaimSubject;
  via: "direct" | "inherited" | "incident" | "endpoint";
  depth: number;
  provenance: ProvenanceClaim;
  recorded: DecisionEntry["recorded"];
}

export interface DecisionClaimSubject {
  kind: "node" | "edge";
  ref: string;
}

export type ExplainDecisionResult =
  | {
      found: true;
      ref: string;
      claims: DecisionClaimView[];
      summary: {
        total: number;
        observations: number;
        gates: Record<ClaimGate, number>;
      };
      notes: string[];
    }
  | {
      found: false;
      ref: string;
      notes: string[];
    };

/**
 * The decision(s) at a node or edge, each with the alternatives it rejected.
 * `alternatives[].name` + `whyNot` are always included; a record with no
 * reasoned rejection is flagged `observation: true`, never hidden.
 *
 * Node refs reuse `whyDoesThisExist` (direct, inherited, and incident
 * claims). Edge refs report decisions naming the edge plus decisions naming
 * its endpoint nodes (via "endpoint").
 */
export function explainDecision(graph: GraphSlice, ref: string): ExplainDecisionResult {
  const index = new GraphIndex(graph);
  const node = graph.nodes.find((candidate) => candidate.id === ref);
  const edge = node === undefined ? graph.edges.find((candidate) => candidate.id === ref) : undefined;
  if (node === undefined && edge === undefined) {
    return {
      found: false,
      ref,
      notes: [`No node or edge "${ref}" exists in this graph.`],
    };
  }

  if (node !== undefined) {
    const why = whyDoesThisExist(graph, ref);
    const claims: DecisionClaimView[] = why.claims.map((claim) => ({
      decisionId: claim.decision.id,
      topic: claim.decision.topic,
      decision: claim.decision.decision,
      rationale: claim.decision.rationale,
      timestamp: claim.decision.timestamp,
      rejectedAlternatives: claim.rejectedAlternatives.map((alternative) => ({
        name: alternative.name,
        whyNot: alternative.whyNot,
      })),
      alternatives: claim.decision.alternatives.map((alternative) => ({
        name: alternative.name,
        whyNot: alternative.whyNot,
      })),
      observation: claim.observation,
      subject: { kind: claim.claim.subject.kind, ref: claim.claim.subject.ref },
      via: claim.claim.via,
      depth: claim.claim.depth,
      provenance: {
        gate: claim.claim.gate,
        evidence: [...claim.claim.provenance.evidence],
        caveats: [...claim.claim.caveats],
      },
      recorded: claim.claim.provenance.recorded,
    }));
    const gates: Record<ClaimGate, number> = { authored: 0, derived: 0, unresolved: 0 };
    for (const claim of claims) gates[claim.provenance.gate] += 1;
    const notes = [...why.notes];
    if (claims.length === 0) {
      notes.push(
        `No decision is recorded against "${ref}". Absence of a recorded reason is ` +
          `not evidence that there was none.`
      );
    }
    return {
      found: true,
      ref,
      claims,
      summary: {
        total: claims.length,
        observations: claims.filter((claim) => claim.observation).length,
        gates,
      },
      notes,
    };
  }

  const claims: DecisionClaimView[] = [];
  for (const decision of graph.decisions) {
    for (const subject of decision.subjects) {
      let via: DecisionClaimView["via"] | null = null;
      if (subject.kind === "edge" && subject.ref === ref) {
        via = "direct";
      } else if (
        subject.kind === "node" &&
        (subject.ref === edge!.from || subject.ref === edge!.to)
      ) {
        via = "endpoint";
      }
      if (via === null) continue;
      const entry = decisionEntryFor(graph, index, decision.id, subject, via);
      if (entry === null) continue;
      claims.push({
        decisionId: entry.id,
        topic: entry.topic,
        decision: entry.decision,
        rationale: entry.rationale,
        timestamp: entry.timestamp,
        rejectedAlternatives: entry.alternatives,
        alternatives: entry.alternatives,
        observation: entry.observation,
        subject: { kind: subject.kind, ref: subject.ref },
        via,
        depth: 0,
        provenance: entry.provenance,
        recorded: entry.recorded,
      });
    }
  }
  claims.sort((a, b) => (a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0));
  const gates: Record<ClaimGate, number> = { authored: 0, derived: 0, unresolved: 0 };
  for (const claim of claims) gates[claim.provenance.gate] += 1;
  return {
    found: true,
    ref,
    claims,
    summary: {
      total: claims.length,
      observations: claims.filter((claim) => claim.observation).length,
      gates,
    },
    notes:
      claims.length === 0
        ? [
            `No decision is recorded against edge "${ref}" or its endpoints. Absence of a ` +
              `recorded reason is not evidence that there was none.`,
          ]
        : [
            `"endpoint" claims explain the edge's nodes, not the edge itself — the edge, ` +
              `not the node, is the subject; the node is half of why it matters.`,
          ],
  };
}

// ---------------------------------------------------------------------------
// followDataShape()
// ---------------------------------------------------------------------------

export interface ShapeLink {
  node: NodeEntry;
  edge: EdgeEntry;
}

export type FollowDataShapeResult =
  | {
      found: true;
      ref: string;
      name: string;
      level: WalkLevel;
      breadcrumb: Breadcrumb;
      /** X writes the shape (X --writes--> shape). */
      writers: ShapeLink[];
      /** X reads the shape (X --reads--> shape). */
      readers: ShapeLink[];
      /** X derives from the shape (X --derives_from--> shape): transformations. */
      transformations: ShapeLink[];
      /** The shape derives from X (shape --derives_from--> X): lineage. */
      lineage: ShapeLink[];
      /** The shape is written into X (shape --writes--> X). */
      outputs: ShapeLink[];
      /** The shape reads X (shape --reads--> X). */
      inputs: ShapeLink[];
      decisions: DecisionEntry[];
      provenance: ProvenanceClaim;
      notes: string[];
    }
  | {
      found: false;
      ref: string;
      notes: string[];
    };

/**
 * Where a datastructure node is defined, written, read, and transformed, via
 * derives_from/reads/writes edges. Works structurally for any node kind, but
 * says so when the ref is not a datastructure.
 */
export function followDataShape(graph: GraphSlice, ref: string): FollowDataShapeResult {
  const node = graph.nodes.find((candidate) => candidate.id === ref);
  if (node === undefined) {
    return { found: false, ref, notes: [`No node "${ref}" exists in this graph.`] };
  }
  const index = new GraphIndex(graph);
  const level: WalkLevel = "subsystem";
  const byId = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]));
  const link = (edge: GraphEdge, otherId: string): ShapeLink | null => {
    const other = byId.get(otherId);
    if (other === undefined) return null;
    return { node: nodeEntry(index, other, level), edge: edgeEntry(index, graph, edge) };
  };

  const writers: ShapeLink[] = [];
  const readers: ShapeLink[] = [];
  const transformations: ShapeLink[] = [];
  const lineage: ShapeLink[] = [];
  const outputs: ShapeLink[] = [];
  const inputs: ShapeLink[] = [];
  const relevant = graph.edges
    .filter((edge) => isStorableKind(edge.kind))
    .filter(
      (edge) =>
        edge.kind === "reads" || edge.kind === "writes" || edge.kind === "derives_from"
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const edge of relevant) {
    if (edge.to === ref && edge.from !== ref) {
      const linked = link(edge, edge.from);
      if (linked === null) continue;
      if (edge.kind === "writes") writers.push(linked);
      else if (edge.kind === "reads") readers.push(linked);
      else transformations.push(linked);
    } else if (edge.from === ref && edge.to !== ref) {
      const linked = link(edge, edge.to);
      if (linked === null) continue;
      if (edge.kind === "derives_from") lineage.push(linked);
      else if (edge.kind === "writes") outputs.push(linked);
      else inputs.push(linked);
    }
  }

  const notes: string[] = [];
  if (node.kind !== "datastructure") {
    notes.push(
      `"${ref}" is a ${node.kind} node, not a datastructure — the groups above are ` +
        `structural (reads/writes/derives_from incidence), interpret accordingly.`
    );
  }
  const total =
    writers.length + readers.length + transformations.length + lineage.length + outputs.length + inputs.length;
  if (total === 0) {
    notes.push(
      `No reads/writes/derives_from edge touches "${ref}". A shape nothing reads or ` +
        `writes is either brand new or already dead.`
    );
  }

  return {
    found: true,
    ref,
    name: node.name,
    level,
    breadcrumb: descendBreadcrumb(undefined, ref),
    writers,
    readers,
    transformations,
    lineage,
    outputs,
    inputs,
    decisions: directDecisions(graph, index, ref),
    provenance: claimForNode(index, node),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Level navigation
// ---------------------------------------------------------------------------

/**
 * Walk one node or edge at a given level: system (concepts, no paths or
 * summaries), subsystem (modules named, edges by kind, decisions), module
 * (real paths, imports, readers/writers). Every node is reachable at every
 * level, tombstones included.
 */
export function viewAtLevel(
  graph: GraphSlice,
  ref: string,
  level: WalkLevel,
  breadcrumb?: Breadcrumb
): OpenResult {
  return open(graph, ref, { level, depth: 1, breadcrumb });
}

export type AscendResult =
  | { moved: true; view: OpenResult }
  | { moved: false; breadcrumb: Breadcrumb; reason: string };

/**
 * Move up one step along a breadcrumb. The parent is re-opened with the
 * sliced trail, so position is preserved rather than restarted at the root.
 */
export function ascend(
  graph: GraphSlice,
  breadcrumb: Breadcrumb,
  options?: { level?: WalkLevel; depth?: number }
): AscendResult {
  if (breadcrumb.length < 2) {
    return {
      moved: false,
      breadcrumb: [...breadcrumb],
      reason: "Already at the system root — there is nowhere further up.",
    };
  }
  const parent = breadcrumb[breadcrumb.length - 2];
  return {
    moved: true,
    view: open(graph, parent, {
      level: options?.level,
      depth: options?.depth,
      breadcrumb: breadcrumb.slice(0, -1),
    }),
  };
}

// Re-exported so callers can build on the same vocabulary without reaching
// into the level machinery directly.
export type {
  AlternativeView,
  Breadcrumb,
  DecisionEntry,
  EdgeEntry,
  GraphSlice as WalkthroughGraphSlice,
  NodeEntry,
  ProvenanceClaim,
  WalkLevel,
};
export type { ClaimGate, StorableEdgeKind };
