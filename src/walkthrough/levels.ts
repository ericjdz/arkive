import type {
  DecisionSubject,
  GraphEdge,
  GraphNode,
  StorableEdgeKind,
} from "../schema/graph.js";
import type { AuthoredProvenance, Provenance } from "../schema/provenance.js";
import {
  GraphIndex,
  caveatsFor,
  decisionProvenance,
  evidenceFor,
  gateFor,
  isObservation,
  projectDecidedBy,
  type ClaimGate,
  type ClaimVia,
  type GraphSlice,
  type SubjectLocation,
} from "../io/decisions.js";

export type { GraphSlice };

/**
 * Layered walkthrough engine (issue 0009, ADR-0003).
 *
 * Pure queries over the graph: no I/O, no LLM calls, deterministic. Every
 * claim carries a provenance gate, evidence, and caveats — reused from
 * `src/io/decisions.ts`, never reworded here.
 *
 * This file is the level machinery: the three walk levels, the breadcrumb,
 * and the per-element entries shaped for a level. The queries themselves
 * (`topology`, `open`, `trace`, and the four named traversals) live in
 * `traversals.ts` and are built on these helpers.
 */

/** The three abstraction layers a learner can stand on. */
export type WalkLevel = "system" | "subsystem" | "module";

/** The breadcrumb root: every trail starts at the system view. */
export const SYSTEM_ROOT = "system";

/** A trail of refs from the system root to the current position. */
export type Breadcrumb = string[];

/** Provenance attached to every claim this module emits. */
export interface ProvenanceClaim {
  /** `derived` (inference from code), `authored` (a person wrote it), or
   * `unresolved` (the subject no longer resolves to a live element). */
  gate: ClaimGate;
  /** `file:line` sites for derived claims; empty otherwise. */
  evidence: string[];
  /** Why the reader should not over-trust this claim. */
  caveats: string[];
}

function claimFor(
  location: SubjectLocation,
  label: string,
  provenance: Provenance | undefined
): ProvenanceClaim {
  return {
    gate: gateFor(location),
    evidence: evidenceFor(provenance),
    caveats: caveatsFor(gateFor(location), label, provenance),
  };
}

/** Provenance claim for a node, resolved through the graph index. */
export function claimForNode(index: GraphIndex, node: GraphNode): ProvenanceClaim {
  return claimFor(index.locate({ kind: "node", ref: node.id }), node.name, node.provenance);
}

/** Provenance claim for an edge, resolved through the graph index. */
export function claimForEdge(index: GraphIndex, edge: GraphEdge): ProvenanceClaim {
  return claimFor(index.locate({ kind: "edge", ref: edge.id }), edge.id, edge.provenance);
}

/** A node rendered for a level. `path` appears at module level only;
 * `summary` appears at subsystem and module level; system level carries
 * concepts (id, kind, name) and nothing that names a file. */
export interface NodeEntry {
  kind: "node";
  id: string;
  nodeKind: GraphNode["kind"];
  name: string;
  live: boolean;
  removedAt?: string;
  summary?: string;
  path?: string;
  provenance: ProvenanceClaim;
}

/** An edge rendered for a level. Edges carry no paths at any level. */
export interface EdgeEntry {
  kind: "edge";
  id: string;
  edgeKind: GraphEdge["kind"];
  from: string;
  to: string;
  fromName: string;
  toName: string;
  label?: string;
  provenance: ProvenanceClaim;
}

/** A rejected alternative, always reported with its reason (even when the
 * reason is empty — that emptiness is what makes a record an observation). */
export interface AlternativeView {
  name: string;
  whyNot: string;
}

/** A decision attached to a node or edge, with its rejected alternatives and
 * the provenance of the element it attaches to. */
export interface DecisionEntry {
  id: string;
  topic: string;
  decision: string;
  rationale: string;
  timestamp: string;
  /** Every alternative, verbatim. A decision is what was *not* chosen. */
  alternatives: AlternativeView[];
  /** True when no alternative carries a reason: an observation, not a decision. */
  observation: boolean;
  /** Which subject of the decision this entry was reached through. */
  subject: DecisionSubject;
  via: ClaimVia | "endpoint";
  provenance: ProvenanceClaim;
  /** Who recorded the decision itself, if anything ever recorded one. */
  recorded: AuthoredProvenance | null;
}

/** Shape a node for a level: system strips `path` and `summary`, subsystem
 * strips `path`, module shows everything the graph records. */
export function nodeEntry(
  index: GraphIndex,
  node: GraphNode,
  level: WalkLevel
): NodeEntry {
  const entry: NodeEntry = {
    kind: "node",
    id: node.id,
    nodeKind: node.kind,
    name: node.name,
    live: node.deletedAt === undefined,
    ...(node.deletedAt === undefined ? {} : { removedAt: node.deletedAt }),
    provenance: claimForNode(index, node),
  };
  if (level !== "system") entry.summary = node.summary;
  if (level === "module" && node.path !== undefined) entry.path = node.path;
  return entry;
}

export function edgeEntry(
  index: GraphIndex,
  graph: GraphSlice,
  edge: GraphEdge
): EdgeEntry {
  return {
    kind: "edge",
    id: edge.id,
    edgeKind: edge.kind,
    from: edge.from,
    to: edge.to,
    fromName: graph.nodes.find((node) => node.id === edge.from)?.name ?? edge.from,
    toName: graph.nodes.find((node) => node.id === edge.to)?.name ?? edge.to,
    ...(edge.label === undefined ? {} : { label: edge.label }),
    provenance: claimForEdge(index, edge),
  };
}

export function decisionEntryFor(
  graph: GraphSlice,
  index: GraphIndex,
  decisionId: string,
  subject: DecisionSubject,
  via: DecisionEntry["via"]
): DecisionEntry | null {
  const decision = graph.decisions.find((candidate) => candidate.id === decisionId);
  if (decision === undefined) return null;
  const location = index.locate(subject);
  const provenance = location.node?.provenance ?? location.edge?.provenance ?? undefined;
  const label =
    location.node?.name ?? location.edge?.id ?? `${subject.kind} ${subject.ref}`;
  const gate = gateFor(location);
  return {
    id: decision.id,
    topic: decision.topic,
    decision: decision.decision,
    rationale: decision.rationale,
    timestamp: decision.timestamp,
    alternatives: decision.alternatives.map((alternative) => ({
      name: alternative.name,
      whyNot: alternative.whyNot,
    })),
    observation: isObservation(decision.alternatives),
    subject,
    via,
    provenance: {
      gate,
      evidence: evidenceFor(provenance),
      caveats: caveatsFor(gate, label, provenance),
    },
    recorded: decisionProvenance(decision),
  };
}

/**
 * Direct `decided_by` decisions for a ref: the `decision.subjects × graph`
 * join, reused from `projectDecidedBy` rather than reimplemented. Only live,
 * directly-named subjects project; tombstoned subjects keep their rationale
 * in the document but produce no edge (see `explainDecision`, which reports
 * those instead of hiding them).
 */
export function directDecisions(
  graph: GraphSlice,
  index: GraphIndex,
  ref: string
): DecisionEntry[] {
  const entries: DecisionEntry[] = [];
  for (const projected of projectDecidedBy(graph)) {
    if (projected.from !== ref) continue;
    const decision = graph.decisions.find((candidate) => candidate.id === projected.to);
    if (decision === undefined) continue;
    const subject = decision.subjects.find(
      (candidate) =>
        (candidate.kind === "node" || candidate.kind === "edge") && candidate.ref === ref
    );
    if (subject === undefined) continue;
    const entry = decisionEntryFor(graph, index, decision.id, subject, "direct");
    if (entry !== null) entries.push(entry);
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return entries;
}

/** Storable edge kinds, for initialising grouped edge records. */
export const STORABLE_EDGE_KINDS: readonly StorableEdgeKind[] = [
  "imports",
  "calls",
  "reads",
  "writes",
  "derives_from",
];

export function emptyEdgeGroups(): Record<StorableEdgeKind, EdgeEntry[]> {
  return { imports: [], calls: [], reads: [], writes: [], derives_from: [] };
}

/**
 * Module children by path containment: a node with path P contains nodes
 * whose path starts with P + "/". The graph records no `contains` edge, so
 * this is the same rule `GraphIndex` uses for reach-through.
 */
export function childNodes(graph: GraphSlice, parent: GraphNode): GraphNode[] {
  if (parent.path === undefined || parent.path.length === 0) return [];
  const prefix = `${parent.path}/`;
  return graph.nodes
    .filter(
      (candidate) =>
        candidate.id !== parent.id &&
        candidate.path !== undefined &&
        candidate.path.startsWith(prefix)
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Extend a breadcrumb with a ref, rooting it at the system root when absent. */
export function descendBreadcrumb(
  breadcrumb: Breadcrumb | undefined,
  ref: string
): Breadcrumb {
  const trail = breadcrumb ?? [SYSTEM_ROOT];
  return trail[trail.length - 1] === ref ? [...trail] : [...trail, ref];
}
