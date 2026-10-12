import { authoredBy } from "../schema/provenance.js";
import type { AuthoredProvenance, Provenance } from "../schema/provenance.js";
import type {
  ArchitectureDocumentV2,
  DecisionSubject,
  GraphAlternative,
  GraphDecision,
  GraphEdge,
  GraphNode,
} from "../schema/graph.js";

/**
 * Decision attachment — `docs/issues/0008-decision-attachment.md`.
 *
 * This is the traversal half of vision layer 1's **Record**. Everything here is
 * a pure function of the graph: nothing reads a file, nothing writes one.
 *
 * Three rules hold everywhere in this file, and each one exists because the
 * naive version of it produces a confident lie.
 *
 * **1. A decision is a claim about a subject, and a subject has provenance.**
 *
 * ADR-0002 splits every element into *derived* (a rule and the `file:line`
 * sites that produced it) or *authored* (a person). "Why does this module
 * exist" is therefore never one object. It is a set of claims, and each claim
 * has to say what it rests on. A reader handed a decision paragraph about a
 * node the scanner guessed at will believe the paragraph; that is the failure
 * mode the whole product exists to avoid, and it is why `whyDoesThisExist`
 * returns a `gate` and a `caveats[]` on every single claim instead of a
 * rationale string.
 *
 * **2. `decided_by` is a projection, never a row.**
 *
 * ADR-0001:78-88 stores decisions as `subjects` and joins them at read time,
 * because storing the edge would put decisions in the blast radius of node
 * deletion and would make "which decision explains the *absence* of an edge"
 * unanswerable. `projectDecidedBy` is that join. It is not called from the write
 * path, and nothing in this file can produce a `decided_by` row that lands on
 * disk.
 *
 * **3. Migration preserves; authoring validates.**
 *
 * A subject that names nothing is a typo and is rejected by the authoring
 * surface. A subject that names a **tombstoned** node is not a typo — it is
 * rationale for something that was legitimately removed, and ADR-0001:131-137
 * requires that to survive. Conflating the two makes the tool refuse a correct
 * operation, which is worse than the typo it prevents.
 *
 * ### Reach-through, and the limit of it
 *
 * "A decision on a parent node must be discoverable from its module children."
 * The graph has no `contains` edge kind and no parent pointer, so containment
 * is **path containment**: a node whose `path` is a directory prefix of
 * another's. `deriveModules` emits exactly this shape — `module:dir:src/io`
 * carries `path: "src/io"` and `module:src/io/tools.ts` carries
 * `path: "src/io/tools.ts"` — so a decision recorded against a directory node
 * reaches every module below it, transitively, with the hop count reported.
 *
 * An authored node with no `path` reaches nothing. That is a real limitation
 * rather than an oversight: inventing containment the document does not record
 * is how a decision ends up explaining a module nobody connected it to. An
 * authored parent that *does* declare `path` reaches its subtree, so the
 * capability is available to human authors as well as to derivation.
 */

/** The three slices of the document this module reads. */
export type GraphSlice = Pick<ArchitectureDocumentV2, "nodes" | "edges" | "decisions">;

/**
 * Whether a subject resolves to something live.
 *
 * `tombstoned` is its own value on purpose — see rule 3 in the file header.
 */
export type SubjectResolution = "resolved" | "tombstoned" | "unresolved";

/**
 * The ADR-0002 confidence gate, as a value rather than a derivation.
 *
 * `derived` and `authored` are the binary ADR-0002 §"Provenance is per element"
 * defines. `unresolved` is added because a claim whose subject no longer exists
 * is neither: it cannot be presented as either without inventing something.
 */
export type ClaimGate = "authored" | "derived" | "unresolved";

/** How a decision reached the node that was asked about. */
export type ClaimVia = "direct" | "inherited" | "incident";

export interface SubjectLocation {
  subject: DecisionSubject;
  resolution: SubjectResolution;
  node?: GraphNode;
  edge?: GraphEdge;
}

/** Index for the per-claim lookups, so a traversal is not O(decisions × nodes). */
export class GraphIndex {
  private readonly nodesById: Map<string, GraphNode>;
  private readonly edgesById: Map<string, GraphEdge>;
  private readonly ancestorsById: Map<string, Array<{ node: GraphNode; depth: number }>>;

  constructor(graph: GraphSlice) {
    this.nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    this.edgesById = new Map(graph.edges.map((edge) => [edge.id, edge]));

    // Containment is walked upwards from each node rather than compared
    // pairwise. The pairwise form is one `startsWith` per node pair, which on a
    // repository `arkive derive` has just scanned is millions of comparisons for
    // an answer that is at most a handful of directory levels deep.
    const byPath = new Map<string, GraphNode[]>();
    for (const node of graph.nodes) {
      // A tombstone reaches nothing. It was removed; the rationale for it is
      // kept, but it is not silently re-pointed at whatever is left below it.
      if (node.deletedAt !== undefined) continue;
      if (node.path === undefined || node.path.length === 0) continue;
      byPath.set(node.path, [...(byPath.get(node.path) ?? []), node]);
    }

    this.ancestorsById = new Map();
    for (const child of this.nodesById.values()) {
      if (child.path === undefined || child.path.length === 0) continue;
      const ancestors: Array<{ node: GraphNode; depth: number }> = [];
      let prefix = parentOfPath(child.path);
      while (prefix.length > 0) {
        for (const candidate of byPath.get(prefix) ?? []) {
          if (candidate.id !== child.id) ancestors.push({ node: candidate, depth: pathDepth(prefix, child.path!) });
        }
        prefix = parentOfPath(prefix);
      }
      // Nearest ancestor first, then stable by id, so two runs over an unchanged
      // document produce byte-identical output.
      ancestors.sort((a, b) => a.depth - b.depth || (a.node.id < b.node.id ? -1 : 1));
      this.ancestorsById.set(child.id, ancestors);
    }
  }

  node(id: string): GraphNode | undefined {
    return this.nodesById.get(id);
  }

  edge(id: string): GraphEdge | undefined {
    return this.edgesById.get(id);
  }

  /** Live ancestors by path containment, nearest first. */
  ancestors(id: string): Array<{ node: GraphNode; depth: number }> {
    return this.ancestorsById.get(id) ?? [];
  }

  /** Where does this subject point, and does it point at anything? */
  locate(subject: DecisionSubject): SubjectLocation {
    if (subject.kind === "edge") {
      const edge = this.edgesById.get(subject.ref);
      return {
        subject,
        resolution: edge === undefined ? "unresolved" : "resolved",
        ...(edge === undefined ? {} : { edge }),
      };
    }
    const node = this.nodesById.get(subject.ref);
    if (node === undefined) return { subject, resolution: "unresolved" };
    return {
      subject,
      resolution: node.deletedAt === undefined ? "resolved" : "tombstoned",
      node,
    };
  }
}

function parentOfPath(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "" : path.slice(0, at);
}

/** Directory segments between a path and a path beneath it. */
function pathDepth(parentPath: string, childPath: string): number {
  const rest = childPath.slice(parentPath.length).replace(/^\/+/, "");
  if (rest.length === 0) return 0;
  return rest.split("/").filter((part) => part.length > 0).length;
}

/**
 * The `decided_by` join (ADR-0001:78-88).
 *
 * Never persisted. Every edge here is derived on demand from
 * `decision.subjects × graph`, which is what makes a node deletion unable to
 * destroy rationale: the decision keeps its subject ref, the ref stops
 * resolving, and the edge simply stops existing.
 *
 * Tombstoned subjects produce no edge — the link is not live — but the decision
 * is untouched. `whyDoesThisExist` is where a tombstoned subject gets reported.
 */
export function projectDecidedBy(graph: GraphSlice): GraphEdge[] {
  const index = new GraphIndex(graph);
  const projected: GraphEdge[] = [];

  for (const decision of graph.decisions) {
    for (const subject of decision.subjects) {
      const location = index.locate(subject);
      if (location.resolution !== "resolved") continue;
      projected.push({
        id: `decided_by:${subject.ref}->${decision.id}`,
        from: subject.ref,
        to: decision.id,
        kind: "decided_by",
        note: `projected from ${decision.id}.subjects — never stored`,
        // ADR-0002:89 puts `decided_by` in the "entirely authored" column, so
        // the projection is authored rather than derived. The provenance a
        // reader should trust is on the *subject*, not on this edge, which is
        // why `whyDoesThisExist` reports that instead of this.
        provenance: authoredBy("agent"),
      });
    }
  }

  return projected.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The decision's own provenance, if anything ever recorded one. */
export function decisionProvenance(decision: GraphDecision): AuthoredProvenance | null {
  const raw = (decision as unknown as Record<string, unknown>).provenance;
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  // ADR-0002's `AuthoredProvenanceSchema`, narrowed defensively: a hand-edited
  // document can carry anything, and a decision log nobody can trust is worse
  // than no decision log.
  if (record.derived === false && (record.authoredBy === "agent" || record.authoredBy === "human")) {
    return record as unknown as AuthoredProvenance;
  }
  return null;
}

/** The gate a claim inherits from the element it attaches to. */
export function gateFor(location: SubjectLocation): ClaimGate {
  if (location.resolution !== "resolved") return "unresolved";
  const provenance = location.node?.provenance ?? location.edge?.provenance;
  return provenance?.derived === true ? "derived" : "authored";
}

/** Evidence behind a claim: the `file:line` sites, or nothing. */
export function evidenceFor(provenance: Provenance | undefined): string[] {
  return provenance?.derived === true ? [...provenance.evidence] : [];
}

/**
 * Everything a reader needs to not over-trust one claim.
 *
 * Empty only when the claim attaches to a live node a human has reviewed. That
 * case is rare on purpose — it is the one case where silence is honest.
 */
export function caveatsFor(
  gate: ClaimGate,
  label: string,
  provenance: Provenance | undefined
): string[] {
  if (gate === "unresolved") {
    return [
      `"${label}" does not resolve to a live element of the graph. The rationale is ` +
        `still here because ADR-0001 requires deletion never to destroy it, but it ` +
        `explains something that no longer exists.`,
    ];
  }
  if (gate === "derived") {
    const evidence = evidenceFor(provenance);
    const rule = provenance?.derived === true ? provenance.rule : "unknown rule";
    return [
      `"${label}" is derived by rule "${rule}" from ${evidence.length} evidence site(s). ` +
        `This decision explains an inferred element of the system, not one anybody ` +
        `verified — open the evidence before treating the explanation as settled.` +
        (evidence.length > 0 ? ` Evidence: ${evidence.slice(0, 3).join(", ")}${evidence.length > 3 ? ", …" : ""}.` : ""),
    ];
  }
  if (provenance !== undefined && provenance.derived === false && provenance.reviewedAt === undefined) {
    return [
      `"${label}" is authored by ${provenance.authoredBy} but carries no reviewedAt — ` +
        `nobody has signed off on it. The decision is a record of intent, not a ` +
        `verified fact.`,
    ];
  }
  return [];
}

/**
 * Does this record actually name something it rejected, and say why?
 *
 * The schema enforces `alternatives.min(1)` (commit `f8add27`), but `min(1)`
 * does not require the *reason* to be anything but whitespace. A record with no
 * rejected alternative is an observation, not a decision, and the difference is
 * worth surfacing rather than encoding silently.
 */
export function isObservation(alternatives: readonly GraphAlternative[]): boolean {
  return alternatives.every((alternative) => alternative.whyNot.trim().length === 0);
}

export interface ClaimProvenance {
  /** Provenance of the element the decision attaches to. `null` when unresolved. */
  subject: Provenance | null;
  /** Evidence behind it — `file:line` for a derived subject, empty otherwise. */
  evidence: string[];
  /** Who recorded the decision itself, and whether it was ever reviewed. */
  recorded: AuthoredProvenance | null;
}

export interface ResolvedClaim {
  /** What the decision names. */
  subject: DecisionSubject;
  /** The graph element the claim resolves to, if any. */
  attachedTo: { kind: "node" | "edge"; id: string } | null;
  resolution: SubjectResolution;
  via: ClaimVia;
  /** Directory hops from the deciding element to the node asked about. */
  depth: number;
  provenance: ClaimProvenance;
  gate: ClaimGate;
  caveats: string[];
}

export interface WhyClaim {
  decision: GraphDecision;
  /** Rejected alternatives, restated. A decision is what was *not* chosen. */
  rejectedAlternatives: GraphAlternative[];
  /** True when the record names no alternative with a reason behind it. */
  observation: boolean;
  claim: ResolvedClaim;
}

export interface WhyResult {
  node: {
    id: string;
    kind: GraphNode["kind"];
    name: string;
    summary: string;
    path?: string;
    /** `false` for a tombstone — the node is gone, its rationale is not. */
    live: boolean;
    removedAt?: string;
    provenance: Provenance;
  } | null;
  /** False when no node carries this id at all. */
  found: boolean;
  claims: WhyClaim[];
  summary: {
    direct: number;
    inherited: number;
    incident: number;
    gates: Record<ClaimGate, number>;
    unresolvedSubjects: number;
  };
  notes: string[];
}

/**
 * "Why does this module exist?" in one traversal.
 *
 * Returns the decision, its rationale, its rejected alternatives, and **the
 * provenance of every claim in it**. Not a summary — the claims are the answer,
 * and each one carries enough for a reader to decide how much of it to believe.
 */
export function whyDoesThisExist(graph: GraphSlice, nodeId: string): WhyResult {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);

  if (node === undefined) {
    return {
      node: null,
      found: false,
      claims: [],
      summary: { direct: 0, inherited: 0, incident: 0, gates: emptyGates(), unresolvedSubjects: 0 },
      notes: [
        `No node "${nodeId}" exists in this graph. A decision explaining it, if one ` +
          `was ever recorded, still names it — check the document's decisions directly.`,
      ],
    };
  }

  const index = new GraphIndex(graph);
  const claims: WhyClaim[] = [];
  const gates = emptyGates();
  let direct = 0;
  let inherited = 0;
  let incident = 0;
  let unresolvedSubjects = 0;

  for (const decision of graph.decisions) {
    const observation = isObservation(decision.alternatives);

    for (const subject of decision.subjects) {
      const reach = howItReaches(index, subject, nodeId);
      if (reach === null) continue;

      const location = index.locate(subject);
      const gate = gateFor(location);
      const provenance =
        location.node?.provenance ?? location.edge?.provenance ?? undefined;
      const label =
        location.node?.name ?? location.edge?.id ?? `${subject.kind} ${subject.ref}`;

      gates[gate] += 1;
      if (gate === "unresolved") unresolvedSubjects += 1;
      if (reach.via === "direct") direct += 1;
      else if (reach.via === "inherited") inherited += 1;
      else incident += 1;

      const caveats = caveatsFor(gate, label, provenance);
      if (observation) {
        caveats.push(
          "This record names no alternative it rejected with a reason. It is an " +
            "observation about the system, not a decision about a choice."
        );
      }

      claims.push({
        decision,
        rejectedAlternatives: decision.alternatives,
        observation,
        claim: {
          subject,
          attachedTo: location.node
            ? { kind: "node", id: location.node.id }
            : location.edge
              ? { kind: "edge", id: location.edge.id }
              : null,
          resolution: location.resolution,
          via: reach.via,
          depth: reach.depth,
          provenance: {
            subject: provenance ?? null,
            evidence: evidenceFor(provenance),
            recorded: decisionProvenance(decision),
          },
          gate,
          caveats,
        },
      });
    }
  }

  const notes: string[] = [];
  if (node.deletedAt !== undefined) {
    notes.push(
      `Node "${node.id}" was removed at ${node.deletedAt}. Its decisions are intact ` +
        `by design — ADR-0001 makes removal a tombstone, never a hard delete.`
    );
  }
  if (claims.length === 0) {
    notes.push(
      node.path === undefined
        ? `No decision is recorded against "${node.id}", and it declares no path, so ` +
          `it cannot inherit one from a parent. An authored node that should reach a ` +
          `subtree needs a "path".`
        : `No decision is recorded against "${node.id}" or anything above it in the ` +
          `tree. Absence of a recorded reason is not evidence that there was none.`
    );
  } else {
    notes.push(
      `${inherited} of ${claims.length} claim(s) were inherited from an ancestor: ` +
        `reach-through is path containment, because the graph records no "contains" edge.`
    );
  }

  return {
    node: {
      id: node.id,
      kind: node.kind,
      name: node.name,
      summary: node.summary,
      ...(node.path === undefined ? {} : { path: node.path }),
      live: node.deletedAt === undefined,
      ...(node.deletedAt === undefined ? {} : { removedAt: node.deletedAt }),
      provenance: node.provenance,
    },
    found: true,
    claims,
    summary: { direct, inherited, incident, gates, unresolvedSubjects },
    notes,
  };
}

function emptyGates(): Record<ClaimGate, number> {
  return { authored: 0, derived: 0, unresolved: 0 };
}

/**
 * How a subject reaches the node being asked about, or `null` if it does not.
 *
 * Three shapes, each a different claim and each labelled so the reader is not
 * told a decision about a neighbouring edge explains this node:
 *
 * - `direct` — the decision names this node.
 * - `inherited` — it names a live ancestor by path, at `depth` hops.
 * - `incident` — it names an edge this node is an endpoint of. The edge, not
 *   the node, is the subject; the node is half of why it matters.
 */
function howItReaches(
  index: GraphIndex,
  subject: DecisionSubject,
  nodeId: string
): { via: ClaimVia; depth: number } | null {
  if (subject.kind === "node") {
    if (subject.ref === nodeId) return { via: "direct", depth: 0 };
    const ancestor = index.ancestors(nodeId).find((entry) => entry.node.id === subject.ref);
    return ancestor === undefined ? null : { via: "inherited", depth: ancestor.depth };
  }
  const edge = index.edge(subject.ref);
  if (edge === undefined) return null;
  return edge.from === nodeId || edge.to === nodeId ? { via: "incident", depth: 0 } : null;
}