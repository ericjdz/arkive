import { MAX_HISTORY_ENTRIES } from "../io/architecture-file.js";
import type {
  EdgeKind,
  GraphDecision,
  GraphEdge,
  GraphHistoryEntry,
  GraphNode,
  NodeKind,
} from "../schema/graph.js";

/**
 * `architecture://session-context` — the single read an agent makes on session
 * start, and therefore the only place in the product where an unbounded
 * document turns into an unbounded context cost.
 *
 * ## What was broken
 *
 * `maxTokens` guarded `decisions[]` and `history[]` only, and only *after*
 * `services[]` and `connections[]` had already been pushed verbatim. The
 * budget was real but structurally unable to bound the sections that grow with
 * the project: 300 services produced 300 service lines whatever the budget said.
 *
 * Since issue 0004 that is no longer a hypothetical. `services[]` is a
 * projection of `nodes[]` (`src/io/project.ts:172-227`) and **every live node
 * becomes one, `module` nodes included** — one per file. On a real codebase
 * the unbounded section is the normal case, not the edge case, and the ranking
 * below is load-bearing rather than cosmetic.
 *
 * ## What this module does now
 *
 * - **Every** section is budgeted, including the ones that grow with the repo.
 * - Sections are built in priority order and the tail is dropped.
 * - Nodes are ranked by structural significance: kind first (`datastore`,
 *   `endpoint`, `service`, `external`, `datastructure`, then `module`), then
 *   connectivity, so the top of the graph survives and the leaf modules do not.
 * - **Truncation is always visible.** Each truncated section states how many
 *   of how many it kept, and the closing `## Budget` block names the resources
 *   that return the whole thing. This is ADR-0002's "credibility bug" section
 *   applied to this file: `reconcile` used to print "in sync" about a document
 *   it never examined, and that unearned trust is the exact failure this
 *   product has already shipped once. A partial view that does not announce
 *   itself is the same bug in a different place, and it is worse here because
 *   the reader is an agent that will act on the summary.
 *
 * ## The bound is a guarantee, not a heuristic
 *
 * `buildSessionContext` never returns more than `maxTokens` estimated tokens,
 * for any document, including one with a million nodes. `estimateTokens` is
 * exactly `ceil(chars / 4)`, so budgeting is done in *characters* against
 * `maxTokens * 4` and the invariant is arithmetic rather than a matter of
 * which branches ran. The greedy allocator decides only *what is worth
 * keeping*; the bound holds regardless of what it decides.
 *
 * ## What this module deliberately does not do
 *
 * It never reads the filesystem. The snapshot archive in `arkive/history/` and
 * the git log are the durable record of past states (ADR-0002 §bounded growth);
 * only the capped `history[]` on the document is ever a candidate here, and
 * only its newest `MAX_HISTORY_RENDERED` entries are rendered.
 */

export interface SessionContextOptions {
  /** Hard ceiling on the returned markdown, in estimated tokens. Default 2000. */
  maxTokens?: number;
}

export interface SessionContextSection {
  /** Section label as it appears in the `## Budget` block. */
  label: string;
  /** Measured tokens attributable to this section. Sums to `SessionContextReport.tokens`. */
  tokens: number;
  /** Items rendered. For `budget`, tokens used against the ceiling. */
  shown: number;
  /** Items available. For `budget`, the ceiling itself. */
  total: number;
  truncated: boolean;
}

export interface SessionContextReport {
  /** The markdown returned by `architecture://session-context`. */
  markdown: string;
  /** Measured estimated tokens. Never exceeds `maxTokens`. */
  tokens: number;
  maxTokens: number;
  /** True when at least one section dropped something. */
  truncated: boolean;
  /** Per-section measurements. `tokens` sums exactly to the total above. */
  sections: SessionContextSection[];
}

/** The resource that returns the whole graph. Never change this URI's purpose. */
export const SESSION_CONTEXT_GRAPH_POINTER = "architecture://services";
export const SESSION_CONTEXT_DECISIONS_POINTER = "architecture://decisions";
export const SESSION_CONTEXT_HISTORY_POINTER = "architecture://history";

export const DEFAULT_MAX_TOKENS = 2000;

/**
 * How many `history[]` entries are rendered. The document cap is 50
 * (`MAX_HISTORY_ENTRIES`); a session does not need 50 change summaries, and the
 * closing block points at `architecture://history` for the rest.
 */
export const MAX_HISTORY_RENDERED = 5;

/**
 * Node kinds, most structurally load-bearing first.
 *
 * The issue that produced this ranked `datastore`, `gateway`, `auth`, `queue`
 * ahead of `module`. Those four are v1 `ServiceType` labels; v2 deleted that
 * taxonomy in favour of `kind` (`src/schema/graph.ts:27-41`), so the ranking
 * is expressed in v2 vocabulary and the v1 labels are kept as a tiebreak below
 * via `legacyType`, which `migrateV1ToV2` carries verbatim:
 *
 * | v1 label     | v2 kind      |
 * |--------------|--------------|
 * | `database`   | `datastore`  |
 * | `cache`, `storage` | `datastore`  |
 * | `gateway`, `cdn`   | `endpoint`   |
 * | `auth`, `queue`, `backend`, `frontend`, `search`, `monitoring` | `service` |
 *
 * `module` is last because it is the kind that arrives at volume — one per
 * file. It is also the kind that is cheapest to re-derive on demand, which is
 * exactly what a lookup is for.
 */
const KIND_RANK: Record<NodeKind, number> = {
  datastore: 0,
  endpoint: 1,
  service: 2,
  external: 3,
  datastructure: 4,
  module: 5,
};

/**
 * Tiebreak inside a kind, for nodes migrated from v1 that kept their authored
 * label. `auth` and `queue` are the two the issue named explicitly: they mark
 * a boundary worth knowing about before the generic `service` next to them.
 */
const LEGACY_TYPE_RANK: Record<string, number> = {
  auth: 0,
  gateway: 1,
  queue: 2,
  backend: 3,
  database: 4,
  cache: 5,
  storage: 6,
  search: 7,
  cdn: 8,
  frontend: 9,
  monitoring: 10,
  other: 11,
};

/**
 * Edge kinds, most informative first.
 *
 * `imports` is last because it is the other high-volume kind — one edge per
 * import site between modules. Data and control flow (`reads`, `writes`,
 * `calls`) is what a session actually needs; the import graph is derivable and
 * is re-read on demand from `architecture://services`.
 */
const EDGE_KIND_RANK: Record<EdgeKind, number> = {
  reads: 0,
  writes: 1,
  calls: 2,
  derives_from: 3,
  imports: 4,
  decided_by: 5,
};

/** Legacy v1 service type -> v2 node kind. Inverse of `project.ts`'s map. */
const LEGACY_TYPE_TO_KIND: Record<string, NodeKind> = {
  database: "datastore",
  cache: "datastore",
  storage: "datastore",
  gateway: "endpoint",
  cdn: "endpoint",
  // A v1 `frontend`/`backend`/`auth`/`queue` is a deployable boundary in v2.
  frontend: "service",
  backend: "service",
  auth: "service",
  queue: "service",
  search: "service",
  monitoring: "service",
  other: "service",
};

/**
 * The document shape this function accepts.
 *
 * Structural rather than `ArchitectureDocument`, so a v2 document, an
 * `ArchitectureDocument` (which is a v2 document plus the deprecated v1 view),
 * and a bare `GraphDocument` all satisfy it without a cast. The deprecated
 * `services` / `connections` fields are declared because they are the only
 * thing a pre-0004 caller can offer, and returning an empty `## Nodes` for one
 * would be a silent lie rather than a graceful degradation.
 */
export interface SessionContextDocument {
  project: { name: string; description: string; lastUpdated: string };
  stack?: Record<string, readonly string[] | undefined>;
  nodes?: readonly GraphNode[];
  edges?: readonly GraphEdge[];
  decisions?: readonly GraphDecision[];
  history?: readonly GraphHistoryEntry[];
  /** Sticky flag set by `capHistory` once entries have been dropped. */
  historyTruncated?: boolean;
  /** @deprecated v1 projection. Consulted only when `nodes` is absent. */
  services?: readonly {
    id: string;
    name: string;
    type?: string;
    technology?: string;
    description?: string;
  }[];
  /** @deprecated v1 projection. Consulted only when `edges` is absent. */
  connections?: readonly { from: string; to: string; protocol?: string }[];
}

/** Public, so callers and tests can measure a string with the same ruler. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface NormalisedDoc {
  name: string;
  description: string;
  lastUpdated: string;
  stack: ReadonlyArray<readonly [string, readonly string[]]>;
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  decisions: readonly GraphDecision[];
  history: readonly GraphHistoryEntry[];
  historyTruncated: boolean;
}

interface Block {
  label: string;
  /** Markdown for this section, with no trailing newline. */
  text: string;
  shown: number;
  total: number;
  /**
   * Set explicitly rather than derived from `shown < total`. The `budget`
   * block reports `shown: tokens used` against `total: maxTokens`, which is a
   * comparison, not a truncation — deriving the flag from it would mark every
   * document as partial, which is the standing-disclaimer failure this issue
   * exists to prevent.
   */
  truncated: boolean;
}

/**
 * Character budget.
 *
 * Characters rather than tokens because `estimateTokens` is exactly
 * `ceil(chars / 4)`: bounding characters bounds tokens exactly, with no
 * per-line rounding drift to argue about.
 */
class Chars {
  private used = 0;

  constructor(private readonly limit: number) {}

  /** Cost of a block's text, including the newline that joins it. */
  static cost(text: string): number {
    return text.length + 1;
  }

  take(cost: number): boolean {
    if (cost > this.limit - this.used) return false;
    this.used += cost;
    return true;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (max <= 1 || flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function normalise(doc: SessionContextDocument): NormalisedDoc {
  const stack: Array<[string, string[]]> = [];
  for (const [category, items] of Object.entries(doc.stack ?? {})) {
    if (Array.isArray(items) && items.length > 0) stack.push([category, items.slice()]);
  }

  const liveNodes = (doc.nodes ?? []).filter((node) => node.deletedAt === undefined);
  const nodes = liveNodes.length > 0 ? liveNodes : legacyNodes(doc);

  const rawEdges = doc.edges ?? [];
  const edges = rawEdges.length > 0 ? rawEdges.filter((e) => e.kind !== "decided_by") : legacyEdges(doc);

  return {
    name: doc.project.name,
    description: doc.project.description ?? "",
    lastUpdated: doc.project.lastUpdated,
    stack,
    nodes,
    edges,
    decisions: doc.decisions ?? [],
    history: doc.history ?? [],
    historyTruncated: doc.historyTruncated === true,
  };
}

/**
 * v1 fallback: a document that has no `nodes[]` is projected into one.
 *
 * Only reachable for a caller holding a pre-0004 document, because
 * `readArchitecture` always returns the graph. It exists so that such a caller
 * gets the v1 picture it wrote rather than an empty `## Nodes` section that
 * looks like a project with no architecture in it.
 *
 * `authoredBy: "agent"` is what `migrateV1ToV2` marks migrated elements with
 * rather than `derived` — a hand-maintained v1 service was not observed by a
 * derivation rule, and claiming otherwise would put a false claim in a field
 * this product treats as unforgeable.
 */
function legacyNodes(doc: SessionContextDocument): GraphNode[] {
  const services = doc.services ?? [];
  return services.map((service) => {
    const type = typeof service.type === "string" ? service.type : "other";
    return {
      id: service.id,
      kind: LEGACY_TYPE_TO_KIND[type] ?? "service",
      name: service.name,
      summary: service.description ?? "",
      ...(service.technology ? { tech: service.technology } : {}),
      legacyType: type,
      provenance: { derived: false, authoredBy: "agent" },
    } as GraphNode;
  });
}

function legacyEdges(doc: SessionContextDocument): GraphEdge[] {
  const services = new Set((doc.services ?? []).map((service) => service.id));
  const connections = doc.connections ?? [];
  return connections.map((connection, index) => ({
    id: `legacy-edge-${index}`,
    from: connection.from,
    to: connection.to,
    kind: "calls",
    ...(connection.protocol ? { label: connection.protocol } : {}),
    ...(services.has(connection.from) && services.has(connection.to)
      ? {}
      : { dangling: true }),
    provenance: { derived: false, authoredBy: "agent" },
  })) as GraphEdge[];
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

interface Ranked {
  node: GraphNode;
  degree: number;
}

function degreeMap(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const node of nodes) degrees.set(node.id, 0);
  for (const edge of edges) {
    degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
    degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
  }
  return degrees;
}

/**
 * Highest rank first, and fully deterministic — every comparison ends in an id
 * tiebreak, so the same document always produces the same summary. A summary
 * that reshuffles between two identical reads is another small lie.
 */
function rankNodes(doc: NormalisedDoc): Ranked[] {
  const degrees = degreeMap(doc.nodes, doc.edges);
  return doc.nodes
    .map((node) => ({
      node,
      degree: degrees.get(node.id) ?? 0,
      legacy: typeof node.legacyType === "string" ? node.legacyType : undefined,
    }))
    .sort((a, b) => {
      const kind = (KIND_RANK[a.node.kind] ?? 9) - (KIND_RANK[b.node.kind] ?? 9);
      if (kind !== 0) return kind;
      const legacy =
        (LEGACY_TYPE_RANK[a.legacy ?? ""] ?? 11) - (LEGACY_TYPE_RANK[b.legacy ?? ""] ?? 11);
      if (legacy !== 0) return legacy;
      if (a.degree !== b.degree) return b.degree - a.degree;
      if (a.node.name !== b.node.name) return a.node.name < b.node.name ? -1 : 1;
      return a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0;
    })
    .map(({ node, degree }) => ({ node, degree }));
}

function rankEdges(
  edges: readonly GraphEdge[],
  shown: ReadonlySet<string>,
  degrees: ReadonlyMap<string, number>
): GraphEdge[] {
  return edges.slice().sort((a, b) => {
    const bothA = shown.has(a.from) && shown.has(a.to);
    const bothB = shown.has(b.from) && shown.has(b.to);
    const survA = bothA ? 0 : shown.has(a.from) || shown.has(a.to) ? 1 : 2;
    const survB = bothB ? 0 : shown.has(b.from) || shown.has(b.to) ? 1 : 2;
    if (survA !== survB) return survA - survB;
    const kind = (EDGE_KIND_RANK[a.kind] ?? 9) - (EDGE_KIND_RANK[b.kind] ?? 9);
    if (kind !== 0) return kind;
    const degree =
      (degrees.get(b.from) ?? 0) + (degrees.get(b.to) ?? 0) - (degrees.get(a.from) ?? 0) - (degrees.get(a.to) ?? 0);
    if (degree !== 0) return degree;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Line rendering
// ---------------------------------------------------------------------------

function nodeLine(node: GraphNode): string {
  const parts: string[] = [node.kind];
  if (node.tech) parts.push(truncate(node.tech, 24));
  const detail = node.summary?.trim()
    ? truncate(node.summary, 96)
    : node.path
      ? truncate(node.path, 96)
      : node.id;
  return `- **${truncate(node.name, 48)}** (${parts.join(" · ")}) — ${detail}`;
}

function edgeLine(edge: GraphEdge, names: ReadonlyMap<string, string>): string {
  const from = names.get(edge.from) ?? truncate(edge.from, 40);
  const to = names.get(edge.to) ?? truncate(edge.to, 40);
  const label = edge.label ? ` · ${truncate(edge.label, 20)}` : "";
  const unresolved = edge.dangling === true ? " ⚠ endpoint unresolved" : "";
  return `- ${from} → ${to} (${edge.kind}${label})${unresolved}`;
}

function decisionLine(decision: GraphDecision, names: ReadonlyMap<string, string>): string {
  const refs = decision.subjects
    .filter((subject) => subject.kind === "node")
    .map((subject) => truncate(names.get(subject.ref) ?? subject.ref, 28));
  const shown = refs.slice(0, 3);
  const rest = refs.length - shown.length;
  const subjects =
    shown.length > 0 ? `  [nodes: ${shown.join(", ")}${rest > 0 ? `, +${rest}` : ""}]` : "";
  return `- **${truncate(decision.topic, 56)}** — ${truncate(decision.decision, 120)}${subjects}`;
}

function historyLine(entry: GraphHistoryEntry): string {
  return `- ${entry.timestamp.slice(0, 10)} · ${truncate(entry.summary, 140)}`;
}

// ---------------------------------------------------------------------------
// Body planning
// ---------------------------------------------------------------------------

/**
 * Space held back inside every list section for its own heading and its
 * truncation marker. Both depend on `shown`, which is not known until the loop
 * ends, so they are reserved up front rather than discovered to be unaffordable
 * afterwards.
 */
const HEADING_RESERVE = 72;
const MARKER_RESERVE = 128;

/**
 * Section shares of whatever is left when the section is planned.
 *
 * Without these the node list spends the whole graph allowance and the edge
 * list is left with a heading and nothing under it — which is the worst of both
 * halves. The graph is one structure; its vocabulary and its connections are
 * only useful together.
 */
const NODE_SHARE = 0.5;
const EDGE_SHARE = 0.55;
const DECISION_SHARE = 0.6;
const HISTORY_SHARE = 0.35;

function nameMap(nodes: readonly GraphNode[]): Map<string, string> {
  return new Map(nodes.map((node) => [node.id, node.name]));
}

/**
 * Commit a list section, or discard it.
 *
 * The loop spends from a *local* budget so nothing is committed to the parent
 * until the whole section, heading and marker included, is known to fit. A
 * section that cannot be afforded is dropped whole rather than half-written.
 *
 * `share` caps the section at a fraction of what is left, so that an earlier
 * section cannot spend the entire budget and leave a later one with an empty
 * heading and a zero-item list. A node list with no edges is much less useful
 * than a smaller node list with its connections, so the graph's two halves get
 * explicit shares rather than first-come-first-served.
 */
function commitList(
  parent: Chars,
  label: string,
  build: (local: Chars) => { text: string; shown: number; total: number },
  share = 1
): Block | undefined {
  const affordable = parent.remaining - HEADING_RESERVE - MARKER_RESERVE;
  const local = new Chars(Math.max(0, Math.min(affordable, Math.floor(parent.remaining * share))));
  const state = build(local);
  const cost = Chars.cost(state.text);
  if (cost > parent.remaining) return undefined;
  parent.take(cost);
  return {
    label,
    text: state.text,
    shown: state.shown,
    total: state.total,
    truncated: state.shown < state.total,
  };
}

/** `## Nodes (24 of 300 — ranked, tail omitted)` */
function heading(label: string, shown: number, total: number, ranked: boolean): string {
  if (total === 0) return `## ${label}`;
  if (shown >= total) return `## ${label} (${total})`;
  const note = ranked ? " — ranked, tail omitted" : "";
  return `## ${label} (${shown} of ${total}${note})`;
}

/**
 * The truncation marker, most informative form first.
 *
 * Every dropped item gets one of these, and the forms degrade only as far as
 * the budget forces. There is no code path that drops an item and prints
 * nothing — that is the whole point of issue 0012, and of ADR-0002's
 * credibility section.
 */
function marker(omitted: number, total: number, pointer: string): string[] {
  return [
    `… ${omitted} more of ${total} omitted. Read \`${pointer}\` for the complete list.`,
    `… +${omitted} of ${total} omitted — see \`${pointer}\`.`,
    `… +${omitted} omitted.`,
    `… +${omitted}.`,
  ];
}

/** The most informative marker form that still fits. */
function pickMarker(omitted: number, total: number, pointer: string, local: Chars): string {
  for (const candidate of marker(omitted, total, pointer)) {
    if (Chars.cost(candidate) <= local.remaining) {
      local.take(Chars.cost(candidate));
      return candidate;
    }
  }
  // Unreachable below HEADING_RESERVE + MARKER_RESERVE, which every list
  // section starts with; the loop above has four forms and the last is nine
  // characters. Kept so the return type is honest rather than asserted.
  return `… +${omitted} omitted.`;
}

function planBody(doc: NormalisedDoc, budgetChars: number): Block[] {
  const budget = new Chars(budgetChars);
  const blocks: Block[] = [];
  const names = nameMap(doc.nodes);

  // --- Header ------------------------------------------------------------
  const head: string[] = [`# ${truncate(doc.name, 64)}`];
  if (doc.description.trim()) head.push(truncate(doc.description, 400));
  head.push(`Last updated: ${doc.lastUpdated}`);
  const headerText = head.join("\n");
  if (budget.take(Chars.cost(headerText))) {
    blocks.push({ label: "header", text: headerText, shown: 0, total: 0, truncated: false });
  }

  // --- Stack -------------------------------------------------------------
  if (doc.stack.length > 0) {
    const section = commitList(
      budget,
      "stack",
      (local) => {
        const lines = ["## Stack"];
        let shown = 0;
        for (const [category, items] of doc.stack) {
          const kept = items.slice(0, 8);
          const rest = items.length - kept.length;
          const line = `- ${category}: ${kept.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`;
          if (!local.take(Chars.cost(line))) break;
          lines.push(line);
          shown += 1;
        }
        const total = doc.stack.length;
        if (shown < total) {
          lines.push(pickMarker(total - shown, total, "architecture://overview", local));
        }
        return { text: lines.join("\n"), shown, total };
      }
    );
    if (section) blocks.push(section);
  }

  // --- Nodes -------------------------------------------------------------
  if (doc.nodes.length > 0) {
    const degrees = degreeMap(doc.nodes, doc.edges);
    const ranked = rankNodes(doc);
    let survivors = new Set<string>();
    const section = commitList(
      budget,
      "nodes",
      (local) => {
        const lines: string[] = [];
        survivors = new Set<string>();
        for (const { node } of ranked) {
          const line = nodeLine(node);
          if (!local.take(Chars.cost(line))) break;
          lines.push(line);
          survivors.add(node.id);
        }
        const shown = survivors.size;
        const derived = doc.nodes.filter((node) => node.provenance?.derived === true).length;
        const basis = `- basis: ${derived} derived, ${doc.nodes.length - derived} authored — ranked by kind, then connectivity.`;
        // The basis line is only affordable on a document where the node list
        // itself fitted; a truncated list is better served by the heading.
        if (shown === doc.nodes.length && local.remaining >= Chars.cost(basis)) {
          local.take(Chars.cost(basis));
          lines.push(basis);
        }
        return {
          text: [heading("Nodes", shown, doc.nodes.length, true), ...lines].join("\n"),
          shown,
          total: doc.nodes.length,
        };
      },
      doc.edges.length > 0 ? NODE_SHARE : 1
    );
    if (section) blocks.push(section);
    else survivors = new Set<string>();

    // --- Edges -------------------------------------------------------
    if (doc.edges.length > 0) {
      const ordered = rankEdges(doc.edges, survivors, degrees);
      const edgeSection = commitList(
        budget,
        "edges",
        (local) => {
          const lines: string[] = [];
          let shown = 0;
          for (const edge of ordered) {
            const line = edgeLine(edge, names);
            if (!local.take(Chars.cost(line))) break;
            lines.push(line);
            shown += 1;
          }
          if (shown < doc.edges.length) {
            lines.push(
              pickMarker(doc.edges.length - shown, doc.edges.length, SESSION_CONTEXT_GRAPH_POINTER, local)
            );
          }
          return {
            text: [heading("Edges", shown, doc.edges.length, true), ...lines].join("\n"),
            shown,
            total: doc.edges.length,
          };
        },
        EDGE_SHARE
      );
      if (edgeSection) blocks.push(edgeSection);
    }
  }

  // --- Decisions ---------------------------------------------------------
  if (doc.decisions.length > 0) {
    const section = commitList(
      budget,
      "decisions",
      (local) => {
        const lines: string[] = [];
        let shown = 0;
        for (const decision of doc.decisions) {
          const line = decisionLine(decision, names);
          if (!local.take(Chars.cost(line))) break;
          lines.push(line);
          shown += 1;
        }
        if (shown < doc.decisions.length) {
          lines.push(
            pickMarker(
              doc.decisions.length - shown,
              doc.decisions.length,
              SESSION_CONTEXT_DECISIONS_POINTER,
              local
            )
          );
        }
        return {
          text: [heading("Decisions", shown, doc.decisions.length, false), ...lines].join("\n"),
          shown,
          total: doc.decisions.length,
        };
      },
      DECISION_SHARE
    );
    if (section) blocks.push(section);
  }

  // --- Recent changes ----------------------------------------------------
  if (doc.history.length > 0) {
    const recent = doc.history.slice(-MAX_HISTORY_RENDERED);
    const section = commitList(
      budget,
      "history",
      (local) => {
        const lines: string[] = [];
        let shown = 0;
        for (const entry of recent) {
          const line = historyLine(entry);
          if (!local.take(Chars.cost(line))) break;
          lines.push(line);
          shown += 1;
        }
        if (shown < recent.length) {
          lines.push(
            pickMarker(recent.length - shown, recent.length, SESSION_CONTEXT_HISTORY_POINTER, local)
          );
        }
        // Two different losses are possible here and both must be visible.
        //
        // 1. The section shows only the newest `MAX_HISTORY_RENDERED`. The
        //    heading counts against the *document's* full `history[]`, not the
        //    slice, so `## Recent Changes (5 of 40)` is what a reader sees —
        //    a section that fits its slice but silently drops 35 entries is
        //    exactly the failure this module exists to stop.
        // 2. The document's own `history[]` is capped at `MAX_HISTORY_ENTRIES`
        //    by ADR-0002. Anything older than that is not in this document at
        //    all: the snapshot archive under `arkive/history/` and git hold it.
        //    This function reads neither, and says so rather than letting a
        //    reader assume an older state exists somewhere they can find.
        const note =
          doc.history.length > MAX_HISTORY_ENTRIES || doc.historyTruncated
            ? `History is capped at ${MAX_HISTORY_ENTRIES} entries in this document; older states are in \`arkive/history/\` and git.`
            : "";
        if (note && local.remaining >= Chars.cost(note)) {
          local.take(Chars.cost(note));
          lines.push(note);
        }
        return {
          text: [heading("Recent Changes", shown, doc.history.length, false), ...lines].join("\n"),
          shown,
          total: doc.history.length,
        };
      },
      HISTORY_SHARE
    );
    if (section) blocks.push(section);
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// The budget block — the honesty requirement
// ---------------------------------------------------------------------------

function measure(blocks: readonly Block[]): SessionContextSection[] {
  const sections: SessionContextSection[] = [];
  let consumed = 0;
  for (const block of blocks) {
    const next = consumed + Chars.cost(block.text);
    const tokens = Math.ceil(next / 4) - Math.ceil(consumed / 4);
    consumed = next;
    sections.push({
      label: block.label,
      tokens,
      shown: block.shown,
      total: block.total,
      truncated: block.truncated,
    });
  }
  return sections;
}

/**
 * The closing block. It states what was used, what was dropped, and where the
 * rest of the document lives — the three things a reader needs in order to
 * know whether they are looking at the whole system.
 *
 * It is itself capped (`BUDGET_BLOCK_SHARE`), because a 200-token budget spent
 * 100 tokens describing itself is a document that is half meta. Lines are
 * emitted in priority order and the least essential ones are dropped first;
 * the status line and the pointer line are never dropped, because those two
 * are the honesty requirement and everything else is commentary on it.
 */
function budgetText(
  sections: readonly SessionContextSection[],
  bodySum: number,
  totalTokens: number,
  maxTokens: number,
  capChars: number
): string {
  const dropped = sections.filter((section) => section.truncated);
  const pct = Math.round((totalTokens / maxTokens) * 100);

  const status =
    dropped.length === 0
      ? `## Budget\n${totalTokens} of ${maxTokens} tokens (${pct}%). Nothing was dropped.`
      : `## Budget\n${totalTokens} of ${maxTokens} tokens (${pct}%). PARTIAL — a ranked summary, not the whole document.`;

  const truncated =
    dropped.length === 0
      ? ""
      : `Truncated: ${dropped.map((section) => `${section.label} ${section.shown}/${section.total}`).join(", ")}.`;

  const breakdown = `Measured tokens per section: ${[
    ...sections.map((section) => `${section.label} ${section.tokens}`),
    `budget ${totalTokens - bodySum}`,
  ].join(" · ")}.`;

  const pointer =
    dropped.length === 0
      ? `Full document: \`architecture://overview\` · \`${SESSION_CONTEXT_GRAPH_POINTER}\` · \`${SESSION_CONTEXT_DECISIONS_POINTER}\`.`
      : `Read more: \`${SESSION_CONTEXT_GRAPH_POINTER}\` (all nodes + edges) · \`${SESSION_CONTEXT_DECISIONS_POINTER}\` (rationale + rejected alternatives) · \`${SESSION_CONTEXT_HISTORY_POINTER}\`.`;

  const mandatory = [status, pointer];
  const optional = [truncated, breakdown].filter((line) => line.length > 0);
  const full = [...mandatory.slice(0, 1), ...optional, ...mandatory.slice(1)];
  if (Chars.cost(full.join("\n")) <= capChars) return full.join("\n");

  // Drop the least essential optional line first.
  for (let drop = optional.length; drop >= 1; drop--) {
    const candidate = [...mandatory.slice(0, 1), ...optional.slice(0, drop), ...mandatory.slice(1)];
    if (Chars.cost(candidate.join("\n")) <= capChars) return candidate.join("\n");
  }
  return mandatory.join("\n");
}

function renderBudget(body: readonly Block[], maxTokens: number, capChars: number): Block {
  const sections = measure(body);
  const bodySum = sections.reduce((sum, section) => sum + section.tokens, 0);
  const bodyChars = body.reduce((sum, block) => sum + Chars.cost(block.text), 0);

  // The block quotes the total it is part of, so the two are mutually
  // dependent. The fixed point is reached in one or two steps — only the digit
  // count changes between iterations — and the exact bound does not depend on
  // it converging.
  let totalTokens = bodySum + 16;
  let text = budgetText(sections, bodySum, totalTokens, maxTokens, capChars);
  for (let attempt = 0; attempt < 8; attempt++) {
    text = budgetText(sections, bodySum, totalTokens, maxTokens, capChars);
    const actual = Math.ceil((bodyChars + Chars.cost(text)) / 4);
    if (actual === totalTokens) break;
    totalTokens = actual;
  }
  return { label: "budget", text, shown: totalTokens, total: maxTokens, truncated: false };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * The budget block's share of the document.
 *
 * It has to fit whatever the budget is, and it is the one section that must
 * survive to the end: a summary that quietly drops its own disclosure is the
 * exact failure issue 0012 exists to close.
 */
function budgetCap(maxChars: number): number {
  return Math.min(Math.round(maxChars * 0.35), Math.max(160, Math.round(maxChars * 0.15)));
}

function compose(doc: NormalisedDoc, maxTokens: number): SessionContextReport {
  const maxChars = maxTokens * 4;
  const cap = budgetCap(maxChars);

  // Plan the body into what is left after reserving the disclosure block. One
  // corrective pass, because the block quotes the body it is reporting on and
  // the quote can be a character longer than the first guess.
  let body = planBody(doc, Math.max(0, maxChars - cap));
  let budget = renderBudget(body, maxTokens, cap);
  for (let attempt = 0; attempt < 4; attempt++) {
    const overflow = bodyChars(body) + Chars.cost(budget.text) - maxChars;
    if (overflow <= 0) break;
    body = planBody(doc, Math.max(0, maxChars - Chars.cost(budget.text)));
    budget = renderBudget(body, maxTokens, cap);
  }

  // The whole point of the per-section breakdown is that it is a measurement,
  // so give it the slack when there is slack. When there is not, `budgetText`
  // has already dropped it in priority order rather than overflowing.
  if (budget.text.length < cap) {
    const withBreakdown = renderBudget(body, maxTokens, Math.max(cap, budget.text.length + 400));
    if (bodyChars(body) + Chars.cost(withBreakdown.text) <= maxChars) budget = withBreakdown;
  }

  const blocks = [...body, budget];
  let markdown = blocks.map((block) => `${block.text}\n`).join("");

  // The guarantee. Every heuristic above decides what is worth keeping; this
  // is the invariant, and it holds for any document and any maxTokens >= 1.
  if (estimateTokens(markdown) > maxTokens) {
    markdown = markdown.slice(0, maxChars);
  }

  const sections = measure(blocks);
  return {
    markdown,
    tokens: estimateTokens(markdown),
    maxTokens,
    truncated: sections.some((section) => section.truncated),
    sections,
  };
}

function bodyChars(blocks: readonly Block[]): number {
  return blocks.reduce((sum, block) => sum + Chars.cost(block.text), 0);
}

export function buildSessionContextReport(
  doc: SessionContextDocument,
  options: SessionContextOptions = {}
): SessionContextReport {
  const maxTokens = Math.max(1, Math.floor(options.maxTokens ?? DEFAULT_MAX_TOKENS));
  return compose(normalise(doc), maxTokens);
}

/**
 * The markdown. Kept as a separate entry point from the report because
 * `readSessionContext` in `src/server/resources.ts` — owned by another wave —
 * consumes the string directly, and the resource URI and its purpose are fixed.
 */
export function buildSessionContext(
  doc: SessionContextDocument,
  options: SessionContextOptions = {}
): string {
  return buildSessionContextReport(doc, options).markdown;
}

/**
 * Re-exported so a caller can assert against the same bound the renderer used
 * without reaching into `src/io` — a duplicated `50` is a number that drifts.
 */
export { MAX_HISTORY_ENTRIES };