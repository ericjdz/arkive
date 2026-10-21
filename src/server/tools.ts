import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  architecturePath,
  ARKIVE_DIR,
  ARCHITECTURE_FILENAME,
  readArchitecture,
  writeArchitecture,
} from "../io/architecture-file.js";
import type { ArchitectureDocument } from "../io/architecture-file.js";
import {
  readPromptQueue,
  claimNextPrompt,
  ackPrompt,
  failPrompt,
} from "../io/prompt-queue.js";
import { removeNode } from "../io/v1-authoring.js";
import {
  caveatsFor,
  evidenceFor,
  gateFor,
  GraphIndex,
  projectDecidedBy,
  whyDoesThisExist,
} from "../io/decisions.js";
import type { ClaimGate, GraphSlice } from "../io/decisions.js";
import { ServiceSchema, ConnectionSchema, DataFlowSchema } from "../schema/architecture.js";
import {
  CURRENT_SCHEMA_VERSION,
  DecisionSubjectSchema,
  GraphAlternativeSchema,
  NodeKindSchema,
} from "../schema/graph.js";
import type {
  ArchitectureDocumentV2,
  DecisionSubject,
  GraphDecision,
  GraphEdge,
  GraphNode,
  NodeKind,
  StorableEdgeKind,
} from "../schema/graph.js";
import { authoredBy, derivedFrom } from "../schema/provenance.js";
import type { Author, Provenance } from "../schema/provenance.js";

/**
 * The MCP authoring surface, speaking v2.
 *
 * `docs/issues/0008-decision-attachment.md` is the reason the graph-owning
 * pieces exist here — `nodes`, `edges`, `decisions` with `subjects` — and the
 * reason the three `remove*` inputs still route through ADR-0001's transaction
 * rather than through the deprecated projection:
 *
 * - **Node removal** is `removeNode` (`src/io/v1-authoring.ts`), the v2
 *   transaction ADR-0001:129-137 specifies. It used to filter
 *   `arch.services`, which only worked because `foldV1ViewOntoGraph` happened
 *   to tombstone whatever the filter hid. A graph-native node with no
 *   `legacyType` was untouchable that way, which is to say the removal was not
 *   happening where the v2 rule says it happens.
 * - **Connection removal** drops the edge itself for the same reason. The v1
 *   filter is kept alongside it so the in-memory projection stays consistent
 *   with the graph and `writeArchitecture` does not fold a connection the
 *   caller already deleted straight back in.
 * - **Decision subjects** are validated against node ids, not service ids
 *   (`src/io/decisions.ts`), and an unknown node is an error while a tombstoned
 *   one is not. Conflating those two makes the tool refuse a correct operation.
 */

/**
 * Why an alternative that records no reason is refused.
 *
 * The schema already enforces `alternatives.min(1)` (commit `f8add27`), and that
 * is kept. `min(1)` alone is not the same rule though: it counts entries, and
 * the artifact this product exists to preserve is not a name — it is a name
 * *and* the reason it lost. `{ name: "MongoDB", whyNot: " " }` satisfies
 * `min(1)` and preserves nothing.
 */
const REJECTED_ALTERNATIVE_REQUIRED =
  "A record with no rejected alternative is an observation, not a decision. Name at " +
  "least one alternative you rejected and say why you rejected it — the reason is the " +
  "artifact this product exists to preserve, and a blank string is not one.";

/**
 * v1's `relatedServices`, refused with its replacement.
 *
 * The field is *declared* so that a caller still sending it gets this message
 * rather than a silent strip. Zod drops an unknown key without a word, and a
 * decision whose subjects vanish between the call and the file is exactly the
 * "agent did the work, the tool threw it away" failure the whole v2 migration
 * was built to end.
 */
const RELATED_SERVICES_REMOVED =
  "`relatedServices` is gone. ADR-0001 replaced it with `subjects`, which can name " +
  "nodes *and* edges and survives their removal. Use `subjects: [{ \"kind\": " +
  "\"node\", \"ref\": \"<node-id>\" }]`; the ids are the same strings, so a caller " +
  "can move them across mechanically.";

/**
 * Edge kinds an authoring caller may create.
 *
 * `satisfies readonly StorableEdgeKind[]` is the check: `decided_by` is not in
 * the v2 `StorableEdgeKind` union, so adding it here is a compile error rather
 * than a review comment (ADR-0001:78-88, `src/schema/graph.ts:229-236`). It is a
 * projection of `decision.subjects`; there is nothing to author.
 */
const STORABLE_EDGE_KINDS = [
  "imports",
  "calls",
  "reads",
  "writes",
  "derives_from",
] as const satisfies readonly StorableEdgeKind[];

const StorableEdgeKindSchema = z.enum(STORABLE_EDGE_KINDS);

/**
 * A node being authored.
 *
 * `provenance` is not an input: it is derived from what the caller supplied.
 * Either `rule` + `evidence` (ADR-0002's derived branch, which is what makes
 * the node a claim a reader can check) or authored by a named author. A caller
 * cannot assert "derived" without citing the sites — the refine below is the
 * authoring-boundary version of `ProvenanceSchema`'s discriminated union.
 */
const NodeAuthoringSchema = z
  .object({
    id: z.string().min(1),
    kind: NodeKindSchema,
    name: z.string().min(1),
    // Empty is honest. `derive.ts` sets `""` for a module node precisely because
    // a description it had no rule for would be a claim no rule observed.
    summary: z.string().optional(),
    tech: z.string().optional(),
    /** Filesystem path. This is what reach-through is computed from. */
    path: z.string().optional(),
    owner: z.string().optional(),
    rule: z.string().min(1).optional(),
    evidence: z.array(z.string().min(1)).min(1).optional(),
    authoredBy: z.enum(["agent", "human"]).optional(),
  })
  .refine(
    (node) =>
      (node.rule === undefined) === (node.evidence === undefined),
    "a node is derived or authored, not both: `rule` and `evidence` must be given together"
  );

/** An edge being authored. `decided_by` is not in `STORABLE_EDGE_KINDS`. */
const EdgeAuthoringSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
    kind: StorableEdgeKindSchema,
    label: z.string().optional(),
    note: z.string().optional(),
    rule: z.string().min(1).optional(),
    evidence: z.array(z.string().min(1)).min(1).optional(),
    authoredBy: z.enum(["agent", "human"]).optional(),
  })
  .refine(
    (edge) => (edge.rule === undefined) === (edge.evidence === undefined),
    "an edge is derived or authored, not both: `rule` and `evidence` must be given together"
  );

/**
 * A decision being recorded.
 *
 * `subjects` is optional, and omitting it is the *attach at creation* path: a
 * decision sent in the same call as the `nodes` / `edges` it explains attaches
 * to all of them, so the human never maintains the link (issue 0008 §1).
 */
const DecisionAuthoringSchema = z.object({
  topic: z.string().min(1),
  decision: z.string().min(1),
  rationale: z.string().min(1),
  alternatives: z
    .array(GraphAlternativeSchema)
    .min(1)
    .refine(
      (alternatives) => alternatives.some((alternative) => alternative.whyNot.trim().length > 0),
      REJECTED_ALTERNATIVE_REQUIRED
    ),
  subjects: z
    .array(DecisionSubjectSchema)
    .optional()
    .describe(
      "What this decision explains, as nodes or edges. Omit to attach to everything the same call created."
    ),
  authoredBy: z.enum(["agent", "human"]).optional(),
});

export const UpdateArchitectureInputSchema = z.object({
  summary: z.string().min(1).describe("One-line summary of what changed (added to history)"),
  /**
   * @deprecated Node ids, not service ids — any `kind` is removed, and the
   * removal is ADR-0001's tombstone transaction rather than a projection
   * filter. The name is kept because it is still the field every installed
   * agent sends.
   */
  removeServiceIds: z.array(z.string()).optional().describe("Node IDs to remove"),
  removeConnectionKeys: z.array(z.string()).optional().describe("Edge keys to remove (format: 'from->to:protocol')"),
  removeDataFlowNames: z.array(z.string()).optional().describe("Data flow names to remove"),
  nodes: z
    .array(NodeAuthoringSchema)
    .optional()
    .describe("Graph nodes to create or update. The v2 authoring surface."),
  edges: z
    .array(EdgeAuthoringSchema)
    .optional()
    .describe("Graph edges to create. `decided_by` is a projection and cannot be authored."),
  decisions: z
    .array(DecisionAuthoringSchema)
    .optional()
    .describe(
      "Decisions to record in the same call. With no `subjects`, each attaches to every node and edge this call created."
    ),
  services: z.array(ServiceSchema).optional(),
  connections: z.array(ConnectionSchema).optional(),
  dataFlows: z.array(DataFlowSchema).optional(),
  stack: z
    .object({
      language: z.array(z.string()).optional(),
      runtime: z.array(z.string()).optional(),
      framework: z.array(z.string()).optional(),
      database: z.array(z.string()).optional(),
      infrastructure: z.array(z.string()).optional(),
    })
    .optional(),
  agent: z.string().optional().describe("Agent identifier (e.g., model name)"),
});

export const RecordDecisionInputSchema = DecisionAuthoringSchema.extend({
  /** @deprecated Declared only so the refusal is loud. See `RELATED_SERVICES_REMOVED`. */
  relatedServices: z.array(z.string()).optional(),
  agent: z.string().optional(),
}).describe(
  "Record a decision. `subjects` names the nodes and edges it explains; omit them and the " +
    "decision is recorded unattached, which `arkive check` will report."
);

export const WhyDoesThisExistInputSchema = z.object({
  nodeId: z.string().min(1).describe("Node id to explain"),
});

export const CheckDriftInputSchema = z.object({});

export const ScaffoldProjectInputSchema = z.object({
  projectPath: z.string().min(1).describe("Absolute path to the project root"),
  projectName: z.string().optional().describe("Project name (defaults to directory name)"),
  standalone: z.boolean().optional().default(false).describe("Generate full instruction files instead of injecting blocks"),
});

export const OpenViewerInputSchema = z.object({
  port: z.number().optional().default(4567).describe("Port to serve the viewer on"),
});

/**
 * @deprecated Consolidated into {@link PromptsInputSchema} (`prompts` tool,
 * issue 0009). Kept so existing imports keep compiling; no longer registered.
 */
export const ListPromptsInputSchema = z.object({
  status: z.enum(["pending", "claimed", "done", "failed"]).optional().describe("Filter by status (omit for all)"),
});

/**
 * @deprecated Consolidated into {@link PromptsInputSchema} (`prompts` tool,
 * issue 0009). Kept so existing imports keep compiling; no longer registered.
 */
export const ClaimNextPromptInputSchema = z.object({
  agent: z.string().optional().describe("Agent identifier claiming the prompt"),
});

/**
 * @deprecated Consolidated into {@link PromptsInputSchema} (`prompts` tool,
 * issue 0009). Kept so existing imports keep compiling; no longer registered.
 */
export const AckPromptInputSchema = z.object({
  promptId: z.string().min(1).describe("ID of the prompt to acknowledge"),
  outcome: z.enum(["done", "failed"]).describe("Whether the prompt was completed or failed"),
});

/**
 * The consolidated prompt-queue tool (issue 0009).
 *
 * Three prompt-queue tools became one `prompts` tool with an `action`
 * discriminator. Every behavior is preserved: `list` keeps the optional status
 * filter, `claim` keeps the optional agent and stays atomic via the
 * prompt-queue CAS, `ack` routes `done` to `ackPrompt` and `failed` to
 * `failPrompt`, and an empty queue claims nothing (`claimed: false`).
 */
export const PromptsInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    status: z.enum(["pending", "claimed", "done", "failed"]).optional().describe("Filter by status (omit for all)"),
  }),
  z.object({
    action: z.literal("claim"),
    agent: z.string().optional().describe("Agent identifier claiming the prompt"),
  }),
  z.object({
    action: z.literal("ack"),
    promptId: z.string().min(1).describe("ID of the prompt to acknowledge"),
    outcome: z.enum(["done", "failed"]).describe("Whether the prompt was completed or failed"),
  }),
]);

/**
 * The walkthrough tool (issue 0009, ADR-0003 §The mechanism).
 *
 * Three traversal primitives, each a pure query over the graph:
 * `topology` (no ref — every node and edge, no prose), `open` (one node or
 * edge into its inbound/outbound edges, module children, data shapes, and
 * `decided_by` decisions), and `trace` (a path through real edges, annotated
 * with the edge kind at each hop — never invented).
 *
 * `why_does_this_exist` stays a separate tool: it is `decisionsAbout`, not a
 * walkthrough traversal. `dataShapes` is part of `open`, not a separate tool.
 */
export const WalkthroughInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("topology"),
  }),
  z.object({
    action: z.literal("open"),
    ref: z.string().min(1).describe("Node or edge id to open"),
    depth: z
      .number()
      .int()
      .min(1)
      .max(3)
      .default(1)
      .describe("Directory hops below ref to include as children (default 1, max 3)"),
  }),
  z.object({
    action: z.literal("trace"),
    entryRef: z.string().min(1).describe("Node id the path starts at"),
    exitRef: z.string().min(1).describe("Node id the path ends at"),
  }),
]);

export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
}

export const ARCHITECTURE_TOOLS: ToolDescriptor[] = [
  {
    name: "update_architecture",
    title: "Update Architecture",
    description:
      "Add or remove nodes, edges, decisions, data flows, or stack entries in the architecture graph. " +
      "A decision passed in the same call attaches to whatever that call created, so the link is never " +
      "maintained by hand. Validates against the schema before writing.",
  },
  {
    name: "record_decision",
    title: "Record Decision",
    description:
      "Append an architectural decision with rationale, rejected alternatives, and the nodes or edges " +
      "it explains (`subjects`). Requires at least one rejected alternative with a reason.",
  },
  {
    name: "check_drift",
    title: "Check Drift",
    description:
      "Run static analysis on package.json and source imports; report mismatches against architecture.json.",
  },
  {
    name: "scaffold_project",
    title: "Scaffold Project",
    description:
      "Initialize arkive in a project directory. Creates architecture.json and injects tracking blocks into instruction files.",
  },
  {
    name: "open_viewer",
    title: "Open Viewer",
    description:
      "Start the arkive web viewer if not already running. Returns the URL for the user to open; the returned URL carries a per-run access token in its fragment and must be opened as-is.",
  },
  {
    name: "prompts",
    title: "Prompts",
    description:
      "List, claim, and acknowledge user-queued prompts from the architecture viewer. " +
      "Action `list` returns prompts with an optional status filter; `claim` atomically claims " +
      "the next pending prompt (empty queue returns claimed:false); `ack` marks a claimed prompt " +
      "as done or failed.",
  },
  {
    name: "why_does_this_exist",
    title: "Why Does This Exist",
    description:
      "Resolve a node id to the decisions that explain it: rationale, rejected alternatives, and the " +
      "provenance of every claim — derived by a rule with evidence, or authored, or no longer " +
      "resolving. A decision on a parent path is found from its module children.",
  },
  {
    name: "walkthrough",
    title: "Walkthrough",
    description:
      "Layered walkthrough queries over the architecture graph (ADR-0003). Action `topology` " +
      "returns every node and edge with no prose; `open` opens one node or edge into its inbound " +
      "and outbound edges by kind, module children, data shapes, and decided_by decisions; " +
      "`trace` returns a path through real edges between two nodes, annotated with the edge kind " +
      "at each hop. Pure queries — never invents nodes, edges, or paths.",
  },
];

interface CallToolResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

let activeViewerServer:
  | { server: import("node:http").Server; port: number; token: string }
  | null = null;

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function jsonResult(body: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
  };
}

/**
 * Drop the v1 view before a v2-only write.
 *
 * `readArchitecture` attaches `services[]` / `connections[]` projected from the
 * graph as it was *before* the call. `writeArchitecture` treats a present copy
 * as a v1 edit and folds it back onto the graph: existing authored-node edits
 * revert, derived nodes acquire meaningless `legacyType` fields, and a
 * re-described connection can mint a duplicate legacy edge. The writer
 * regenerates both arrays from the graph, so the correct move is to drop them.
 */
function dropStaleProjection<T extends object>(document: T): T {
  const payload = document as unknown as Record<string, unknown>;
  delete payload.services;
  delete payload.connections;
  return document;
}

function mergeUnique(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b]));
}

function nextDecisionId(existing: readonly GraphDecision[]): string {
  let max = 0;
  for (const d of existing) {
    const m = /^dec-(\d+)$/.exec(d.id);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return `dec-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Provenance for an authored node or edge, from what the caller supplied.
 *
 * ADR-0002 makes provenance structurally impossible to omit, and the two
 * branches are not interchangeable: `derived` carries a rule and the `file:line`
 * sites behind it, `authored` carries who wrote it. A caller that supplies
 * neither is an author — it called a tool — and says so.
 */
function provenanceFor(input: {
  rule?: string;
  evidence?: string[];
  authoredBy?: Author;
}): Provenance {
  if (input.rule !== undefined && input.evidence !== undefined) {
    return derivedFrom(input.rule, [...input.evidence]);
  }
  return authoredBy(input.authoredBy ?? "agent");
}

/**
 * The same rule `DecisionAuthoringSchema` enforces, re-checked in the handler.
 *
 * The schema refine is what an MCP client sees, because the SDK validates the
 * declared shape before a handler runs. These handlers are also called directly
 * — by tests, by `src/cli/**`, by anything importing `src/server/tools.ts` — and
 * a rule that only exists at the transport boundary is a rule with one door.
 * `min(1)` on `GraphDecisionSchema` catches an empty array on the write path;
 * nothing downstream of this module catches a `whyNot` of `" "`.
 */
function rejectedAlternativeProblem(
  alternatives: ReadonlyArray<{ name: string; whyNot: string }>
): string | null {
  if (alternatives.length === 0) return REJECTED_ALTERNATIVE_REQUIRED;
  return alternatives.some((alternative) => alternative.whyNot.trim().length > 0)
    ? null
    : REJECTED_ALTERNATIVE_REQUIRED;
}

export interface SubjectReport {
  subject: DecisionSubject;
  resolution: "resolved" | "tombstoned" | "unresolved";
  /** The ADR-0002 gate this subject inherits. `unresolved` when it names nothing. */
  gate: ClaimGate;
  /** The element it names, where there is one. */
  element: { kind: "node" | "edge"; id: string; name?: string } | null;
  /** Evidence, for a derived subject. Empty otherwise — never invented. */
  evidence: string[];
  /** Always present unless the claim is authored *and* reviewed. */
  caveats: string[];
}

/**
 * Describe every subject of a recorded decision, with its gate.
 *
 * This is the point where "attach to a derived node" becomes visible at the
 * moment it happens. ADR-0002's table is a binary and a flattened
 * `subjects: string[]` cannot express it, so the tool reports it instead of
 * storing it and hoping a reader notices.
 */
function reportSubjects(
  graph: GraphSlice,
  subjects: readonly DecisionSubject[]
): SubjectReport[] {
  const index = new GraphIndex(graph);
  return subjects.map((subject) => {
    const location = index.locate(subject);
    const provenance = location.node?.provenance ?? location.edge?.provenance;
    const label = location.node?.name ?? location.edge?.id ?? `${subject.kind} ${subject.ref}`;
    return {
      subject,
      resolution: location.resolution,
      gate: gateFor(location),
      element: location.node
        ? { kind: "node" as const, id: location.node.id, name: location.node.name }
        : location.edge
          ? { kind: "edge" as const, id: location.edge.id }
          : null,
      evidence: evidenceFor(provenance),
      caveats: caveatsFor(gateFor(location), label, provenance),
    };
  });
}

/**
 * Reject subjects that name nothing, before the write.
 *
 * `pending` is the set of ids this same call is about to create. The v2 surface
 * applies its node and edge edits here, but the deprecated `services` /
 * `connections` arrays are folded onto the graph *inside* `writeArchitecture`,
 * so their ids are not in the graph yet. Naming one of those is not a typo, and
 * refusing it would make the deprecated surface unable to attach a decision —
 * which is the wrong half of "migration preserves, authoring validates".
 *
 * A **tombstoned** node is never in this error. It was legitimately removed,
 * the decision explaining it is kept on purpose (ADR-0001:131-137), and a tool
 * that refuses to record that is refusing a correct operation.
 */
function checkSubjects(
  index: GraphIndex,
  subjects: readonly DecisionSubject[],
  pending: ReadonlySet<string>
): string | null {
  const unknown: string[] = [];
  for (const subject of subjects) {
    if (pending.has(subject.ref)) continue;
    if (index.locate(subject).resolution === "unresolved") {
      unknown.push(`${subject.kind} "${subject.ref}"`);
    }
  }
  if (unknown.length === 0) return null;
  return (
    `Unknown decision subject(s): ${unknown.join(", ")}. A subject must name an existing ` +
    `node or edge — ADR-0001 replaced \`relatedServices\` with \`subjects\` so this can be ` +
    `checked.`
  );
}

/** Ids this call is about to bring into existence, for `checkSubjects`. */
function pendingIds(input: z.infer<typeof UpdateArchitectureInputSchema>): Set<string> {
  const pending = new Set<string>();
  for (const node of input.nodes ?? []) pending.add(node.id);
  for (const edge of input.edges ?? []) pending.add(edge.id);
  for (const service of input.services ?? []) pending.add(service.id);
  for (const connection of input.connections ?? []) {
    pending.add(connection.from);
    pending.add(connection.to);
  }
  return pending;
}

export async function handleUpdateArchitecture(
  dir: string,
  input: z.infer<typeof UpdateArchitectureInputSchema>
): Promise<CallToolResult> {
  const read = readArchitecture(dir);
  if (!read.success) return errorResult(read.error);

  const arch: ArchitectureDocument = read.data;
  const now = new Date().toISOString();
  const notes: string[] = [];

  // --- nodes ----------------------------------------------------------------
  //
  // Applied before the removals and before the decisions, so a decision in this
  // same call attaches to a node that exists by the time it is validated.
  const createdNodeIds: string[] = [];
  const revivedNodeIds: string[] = [];

  for (const incoming of input.nodes ?? []) {
    const existing = arch.nodes.find((node) => node.id === incoming.id);
    if (existing === undefined) {
      const node: GraphNode = {
        id: incoming.id,
        kind: incoming.kind as NodeKind,
        name: incoming.name,
        summary: incoming.summary ?? "",
        provenance: provenanceFor(incoming),
      };
      if (incoming.tech !== undefined) node.tech = incoming.tech;
      if (incoming.path !== undefined) node.path = incoming.path;
      if (incoming.owner !== undefined) node.owner = incoming.owner;
      arch.nodes.push(node);
      createdNodeIds.push(node.id);
      continue;
    }

    // Re-declaring an existing node updates the authored half and leaves the
    // provenance alone unless the caller cited a rule. `mergeDerived` applies
    // the same rule on the other side of the wall: derivation replaces derived
    // state, and it never overwrites an author.
    if (existing.deletedAt !== undefined) {
      revivedNodeIds.push(existing.id);
      delete existing.deletedAt;
    }
    existing.kind = incoming.kind as NodeKind;
    existing.name = incoming.name;
    if (incoming.summary !== undefined) existing.summary = incoming.summary;
    if (incoming.tech !== undefined) existing.tech = incoming.tech;
    if (incoming.path !== undefined) existing.path = incoming.path;
    if (incoming.owner !== undefined) existing.owner = incoming.owner;
    if (incoming.rule !== undefined && incoming.evidence !== undefined) {
      existing.provenance = derivedFrom(incoming.rule, [...incoming.evidence]);
    }
  }

  // --- removals -------------------------------------------------------------
  //
  // ADR-0001:129-137, applied to the graph rather than to a projection. The
  // v1 arrays below are still filtered so the in-memory view matches the graph
  // `writeArchitecture` is about to fold; without that, the fold would read a
  // service the caller just deleted and rebuild it from the stale copy.
  const removed: Array<{ id: string; droppedEdges: number }> = [];
  const revived = new Set(revivedNodeIds);

  for (const id of input.removeServiceIds ?? []) {
    if (revived.has(id)) {
      return errorResult(
        `Cannot remove "${id}": it was revived from a tombstone earlier in this same ` +
          `call. Add or remove it, not both.`
      );
    }
    const known = arch.nodes.some((node) => node.id === id);
    // The cast narrows `ArchitectureDocument.schemaVersion: number` to the
    // literal `2` the transaction is typed against. `writeArchitecture` stamps
    // the same field from the same constant three lines later.
    const removal = removeNode(
      { ...arch, schemaVersion: CURRENT_SCHEMA_VERSION } as ArchitectureDocumentV2,
      id,
      now
    );
    if (removal.removed !== null) {
      arch.nodes = removal.graph.nodes;
      arch.edges = removal.graph.edges;
      arch.history = removal.graph.history;
      removed.push(removal.removed);
    } else if (!known) {
      // A node that never existed is a typo; a node that is already a tombstone
      // is a completed removal. Only the first is an error, and saying so beats
      // reporting success for a call that changed nothing.
      return errorResult(
        `Cannot remove "${id}": no node with that id exists. Removal is a tombstone, not ` +
          `a delete, so a removed node is still addressable by id.`
      );
    }
    const gone = new Set([...removed.map((entry) => entry.id), id]);
    arch.services = arch.services.filter((service) => !gone.has(service.id));
    arch.connections = arch.connections.filter(
      (connection) => !gone.has(connection.from) && !gone.has(connection.to)
    );
    for (const service of arch.services) {
      service.dependencies = service.dependencies.filter((dependency) => !gone.has(dependency));
    }
  }

  // --- edges ----------------------------------------------------------------
  //
  // `decided_by` is not in `STORABLE_EDGE_KINDS`, so authoring one is a
  // compile error rather than a runtime warning (ADR-0001:78-88).
  const createdEdgeIds: string[] = [];
  const liveIds = new Set(
    arch.nodes.filter((node) => node.deletedAt === undefined).map((node) => node.id)
  );
  // Endpoints the deprecated `services` array is about to create. They are
  // folded onto the graph inside `writeArchitecture`, so at this point they are
  // not in it — and an edge is allowed to point at them.
  const deferred = new Set((input.services ?? []).map((service) => service.id));

  for (const incoming of input.edges ?? []) {
    if (arch.edges.some((edge) => edge.id === incoming.id)) {
      return errorResult(
        `Edge "${incoming.id}" already exists. Edit the existing edge rather than ` +
          `re-declaring it — two edges sharing an id make the document unreadable.`
      );
    }
    const endpoints = [...new Set([incoming.from, incoming.to])];
    const missing = endpoints.filter(
      (endpoint) => !liveIds.has(endpoint) && !deferred.has(endpoint)
    );
    if (missing.length > 0) {
      const tombstoned = missing.filter((id) =>
        arch.nodes.some((node) => node.id === id && node.deletedAt !== undefined)
      );
      return errorResult(
        `Edge "${incoming.id}" references ` +
          `${missing.map((id) => `"${id}"`).join(" and ")}, which ` +
          `${missing.length > 1 ? "do" : "does"} not resolve to a live node` +
          `${tombstoned.length > 0
            ? `. "${tombstoned.join('", "')}" ${tombstoned.length > 1 ? "are" : "is"} ` +
              `tombstoned — re-add the node before pointing an edge at it`
            : ""}.`
        );
    }
    const edge: GraphEdge = {
      id: incoming.id,
      from: incoming.from,
      to: incoming.to,
      kind: incoming.kind,
      provenance: provenanceFor(incoming),
    };
    if (incoming.label !== undefined) edge.label = incoming.label;
    if (incoming.note !== undefined) edge.note = incoming.note;
    arch.edges.push(edge);
    createdEdgeIds.push(edge.id);
  }

  // --- deprecated v1 view ---------------------------------------------------
  if (input.removeConnectionKeys) {
    // The edge is the target, not the projection copy. One removal per key
    // occurrence, which is what the projection's multiset matching did — two
    // edges that project to the same key are still two edges.
    //
    // Both arrays are consumed by one counter on purpose. `services` /
    // `connections` are a 1:1 projection of the live graph edges
    // (`projectConnections`), so they are the same population seen twice; two
    // counters would let the stale copy hand back a connection the edge sweep
    // just deleted, and `writeArchitecture` would fold it straight back onto
    // the graph — a removal that reports success and removes nothing.
    // One requested key names the same relationship in two representations:
    // the stored edge and the projected v1 connection. They need independent
    // counters. Sharing one meant the connections sweep consumed the count and
    // the edge sweep matched nothing, so the edge survived — invisible only
    // because `writeArchitecture` used to fold the filtered `connections[]`
    // back over the graph and delete it there. That fold is gone for v2-only
    // calls, and the surviving edge would re-project the "removed" connection.
    const wantedConnections = new Map<string, number>();
    const wantedEdges = new Map<string, number>();
    for (const key of input.removeConnectionKeys) {
      const next = (wantedConnections.get(key) ?? 0) + 1;
      wantedConnections.set(key, next);
      wantedEdges.set(key, next);
    }

    const keptConnections: typeof arch.connections = [];
    for (const connection of arch.connections) {
      const key = `${connection.from}->${connection.to}:${connection.protocol}`;
      const remaining = wantedConnections.get(key) ?? 0;
      if (remaining > 0) {
        wantedConnections.set(key, remaining - 1);
        continue;
      }
      keptConnections.push(connection);
    }
    arch.connections = keptConnections;

    const keptEdges: GraphEdge[] = [];
    for (const edge of arch.edges) {
      // `imports` edges are `Service.dependencies[]`, not connections, so the
      // v1 key format has never addressed them.
      const key = `${edge.from}->${edge.to}:${edge.label ?? edge.kind}`;
      const remaining = wantedEdges.get(key) ?? 0;
      if (remaining > 0 && edge.kind !== "imports") {
        wantedEdges.set(key, remaining - 1);
        continue;
      }
      keptEdges.push(edge);
    }
    arch.edges = keptEdges;

    const unmatched = [
      ...new Set(
        [...wantedConnections, ...wantedEdges]
          .filter(([, n]) => n > 0)
          .map(([key]) => key)
      ),
    ];
    if (unmatched.length > 0) {
      notes.push(
        `Nothing matched ${unmatched.map((key) => `"${key}"`).join(", ")}. Reported rather ` +
          `than ignored: a removal that quietly matches nothing is a typo the user never sees.`
      );
    }
  }

  if (input.removeDataFlowNames) {
    const toRemove = new Set(input.removeDataFlowNames);
    arch.dataFlows = arch.dataFlows.filter((f) => !toRemove.has(f.name));
  }

  if (input.services) {
    const byId = new Map(arch.services.map((s) => [s.id, s]));
    for (const s of input.services) byId.set(s.id, s);
    arch.services = Array.from(byId.values());
  }

  if (input.connections) {
    const key = (c: { from: string; to: string; protocol: string }) =>
      `${c.from}->${c.to}:${c.protocol}`;
    const byKey = new Map(arch.connections.map((c) => [key(c), c]));
    for (const c of input.connections) byKey.set(key(c), c);
    arch.connections = Array.from(byKey.values());
  }

  if (input.dataFlows) {
    const byName = new Map(arch.dataFlows.map((f) => [f.name, f]));
    for (const f of input.dataFlows) byName.set(f.name, f);
    arch.dataFlows = Array.from(byName.values());
  }

  if (input.stack) {
    if (input.stack.language) arch.stack.language = mergeUnique(arch.stack.language, input.stack.language);
    if (input.stack.runtime) arch.stack.runtime = mergeUnique(arch.stack.runtime, input.stack.runtime);
    if (input.stack.framework) arch.stack.framework = mergeUnique(arch.stack.framework, input.stack.framework);
    if (input.stack.database) arch.stack.database = mergeUnique(arch.stack.database, input.stack.database);
    if (input.stack.infrastructure) arch.stack.infrastructure = mergeUnique(arch.stack.infrastructure, input.stack.infrastructure);
  }

  // --- decisions ------------------------------------------------------------
  //
  // Issue 0008 §1: a decision recorded in the same operation as the structure it
  // explains attaches to that structure with no linking step at all. Omitting
  // `subjects` means "everything this call created" — including anything the
  // deprecated `services` array brought in, whose nodes only exist once
  // `writeArchitecture` has folded them onto the graph.
  const pending = pendingIds(input);
  const index = new GraphIndex(arch);
  const recorded: GraphDecision[] = [];
  const reports: Record<string, SubjectReport[]> = {};

  for (const incoming of input.decisions ?? []) {
    const thin = rejectedAlternativeProblem(incoming.alternatives);
    if (thin !== null) return errorResult(`Decision "${incoming.topic}": ${thin}`);

    const subjects: DecisionSubject[] =
      incoming.subjects ??
      [
        ...createdNodeIds.map((ref) => ({ kind: "node" as const, ref })),
        ...createdEdgeIds.map((ref) => ({ kind: "edge" as const, ref })),
        ...(input.services ?? [])
          .filter((service) => !createdNodeIds.includes(service.id))
          .map((service) => ({ kind: "node" as const, ref: service.id })),
      ];

    const problem = checkSubjects(index, subjects, pending);
    if (problem !== null) return errorResult(problem);

    if (incoming.subjects === undefined && subjects.length === 0) {
      notes.push(
        `"${incoming.topic}" was recorded with no subjects because this call created nothing ` +
          `for it to explain. Record it against what it produced, or expect ` +
          `why_does_this_exist to have nothing to find.`
      );
    }

    const decision: GraphDecision = {
      id: nextDecisionId(arch.decisions),
      topic: incoming.topic,
      decision: incoming.decision,
      rationale: incoming.rationale,
      alternatives: incoming.alternatives,
      timestamp: now,
      subjects,
      // `GraphDecisionSchema` is a `looseObject`, so this rides along and is
      // preserved by ADR-0006 §3. It answers "who claims this", which the
      // rationale alone does not.
      provenance: authoredBy(incoming.authoredBy ?? "agent"),
    };
    // `normaliseDecisions` — run by `writeArchitecture` — re-projects
    // `relatedServices` from `subjects` for v1 readers, so a v2 decision is
    // pushed without it.
    arch.decisions.push(decision as unknown as (typeof arch.decisions)[number]);
    recorded.push(decision);
    arch.history.push({
      timestamp: now,
      action: "architecture_decision",
      summary: `${incoming.topic}: ${incoming.decision}`,
      agent: input.agent,
    });
  }

  arch.history.push({
    timestamp: now,
    action: "update_architecture",
    summary: input.summary,
    agent: input.agent,
  });

  // `readArchitecture` projected `services` / `connections` from the graph as
  // it was *before* this call. Every node and edge edit above left that copy
  // stale, and `writeArchitecture` folds a stored v1 view back onto the graph —
  // so updating an existing authored node was silently reverted to its old
  // values by the very projection it should have replaced. (Measured during
  // 0015: a corrected `viewer` node kept `React + Vite` after the call that
  // changed it, while the history entry said the update succeeded.)
  //
  // Drop the stale view and let the writer regenerate it from the edited graph.
  // Do not set it to a fresh projection here: a present `services[]` is treated
  // as a v1 edit and folded onto the graph, which mints duplicate legacy edges
  // for every connection it re-describes. A caller that sent `services` /
  // `connections` explicitly stays on the legacy fold path, where those arrays
  // are the edit.
  if (input.services === undefined && input.connections === undefined) {
    dropStaleProjection(arch);
  }

  const write = writeArchitecture(dir, arch);
  if (!write.success) return errorResult(write.error);

  // Report the gates against the document that was actually written, not
  // against the pre-fold graph — the write is the only thing that knows which
  // nodes a deprecated `services` entry became.
  for (const decision of recorded) {
    reports[decision.id] = reportSubjects(write.data, decision.subjects);
    for (const report of reports[decision.id]) {
      for (const caveat of report.caveats) {
        notes.push(`${decision.id}: ${caveat}`);
      }
    }
  }

  const decidedBy = projectDecidedBy(write.data).filter((edge) =>
    recorded.some((decision) => decision.id === edge.to)
  );

  return jsonResult({
    ok: true,
    summary: input.summary,
    counts: {
      nodes: write.data.nodes.length,
      edges: write.data.edges.length,
      services: write.data.services.length,
      connections: write.data.connections.length,
      dataFlows: write.data.dataFlows.length,
      decisions: write.data.decisions.length,
    },
    nodes: {
      created: createdNodeIds,
      /** Tombstoned nodes this call brought back. */
      revived: revivedNodeIds,
    },
    edges: { created: createdEdgeIds },
    removed,
    decisions: recorded.map((decision) => ({
      id: decision.id,
      subjects: reports[decision.id].map((report) => report.subject),
      claims: reports[decision.id],
    })),
    // The attach-at-creation evidence, in the shape a caller can assert on.
    // Never stored — this is the ADR-0001 projection, computed from
    // `decision.subjects` on the way out.
    decidedBy,
    notes,
  });
}

export async function handleRecordDecision(
  dir: string,
  input: z.infer<typeof RecordDecisionInputSchema>
): Promise<CallToolResult> {
  if ((input.relatedServices?.length ?? 0) > 0) {
    return errorResult(RELATED_SERVICES_REMOVED);
  }

  const thin = rejectedAlternativeProblem(input.alternatives);
  if (thin !== null) return errorResult(`Decision "${input.topic}": ${thin}`);

  const read = readArchitecture(dir);
  if (!read.success) return errorResult(read.error);

  const arch: ArchitectureDocument = read.data;

  const subjects: DecisionSubject[] = input.subjects ?? [];
  const problem = checkSubjects(new GraphIndex(arch), subjects, new Set());
  if (problem !== null) return errorResult(problem);

  const now = new Date().toISOString();

  const decision: GraphDecision = {
    id: nextDecisionId(arch.decisions),
    topic: input.topic,
    decision: input.decision,
    rationale: input.rationale,
    alternatives: input.alternatives,
    timestamp: now,
    subjects,
    provenance: authoredBy(input.authoredBy ?? "agent"),
  };

  // `normaliseDecisions` — run by `writeArchitecture` — re-projects
  // `relatedServices` from `subjects` for v1 readers, so a v2 decision is
  // pushed without it.
  arch.decisions.push(decision as unknown as (typeof arch.decisions)[number]);
  arch.history.push({
    timestamp: now,
    action: "architecture_decision",
    summary: `${input.topic}: ${input.decision}`,
    agent: input.agent,
  });

  // A decision adds no structure. The only graph change is the decision itself;
  // the v1 view `readArchitecture` attached describes the pre-write graph, and a
  // present copy would be folded back as an edit. Let the writer regenerate it.
  dropStaleProjection(arch);

  const write = writeArchitecture(dir, arch);
  if (!write.success) return errorResult(write.error);

  const claims = reportSubjects(write.data, subjects);

  return jsonResult({
    ok: true,
    decision,
    claims,
    decidedBy: projectDecidedBy(write.data).filter((edge) => edge.to === decision.id),
    notes: [
      ...claims.flatMap((claim) => claim.caveats.map((caveat) => `${decision.id}: ${caveat}`)),
      ...(subjects.length === 0
        ? [
            "This decision has no subjects, so nothing can reach it. Record it with " +
              "`subjects`, or in the same `update_architecture` call as the node it explains.",
          ]
        : []),
    ],
  });
}

/**
 * "Why does this module exist?" — one traversal, one answer.
 *
 * The returned payload is the whole point: a decision is a set of claims about
 * elements of the graph, and each claim says whether the element it rests on was
 * derived by a rule (with the evidence sites) or authored by somebody, or no
 * longer resolves at all. A bare rationale would let a reader believe a
 * confident paragraph about a node the scanner guessed at.
 */
export async function handleWhyDoesThisExist(
  dir: string,
  input: z.infer<typeof WhyDoesThisExistInputSchema>
): Promise<CallToolResult> {
  const read = readArchitecture(dir);
  if (!read.success) return errorResult(read.error);

  const result = whyDoesThisExist(read.data, input.nodeId);
  if (!result.found) return errorResult(result.notes.join(" "));

  return jsonResult(result);
}
export async function handleCheckDrift(dir: string): Promise<CallToolResult> {
  const read = readArchitecture(dir);
  if (!read.success) return errorResult(read.error);

  const { scanProject } = await import("../analysis/scanner.js");
  const { detectDrift } = await import("../analysis/drift.js");

  const scan = scanProject(dir);
  const report = detectDrift(read.data, scan);
  return jsonResult(report);
}

// Input type (not `z.infer`, which is the parsed output type): this handler is
// called with raw, unvalidated MCP arguments and applies its own defaults below.
export async function handleScaffoldProject(
  input: z.input<typeof ScaffoldProjectInputSchema>
): Promise<CallToolResult> {
  try {
    const { initProject } = await import("../cli/commands/init.js");
    const { basename, join } = await import("node:path");
    const { existsSync } = await import("node:fs");

    const projectPath = input.projectPath;
    const archPath = join(projectPath, ARKIVE_DIR, ARCHITECTURE_FILENAME);
    const archExisted = existsSync(archPath);

    initProject({
      name: input.projectName || basename(projectPath),
      dir: projectPath,
      standalone: input.standalone ?? false,
    });

    const filesCreated: string[] = [];
    const filesModified: string[] = [];
    const filesSkipped: string[] = [];

    if (archExisted) {
      filesSkipped.push(`${ARKIVE_DIR}/${ARCHITECTURE_FILENAME}`);
    } else {
      filesCreated.push(`${ARKIVE_DIR}/${ARCHITECTURE_FILENAME}`);
    }

    const claudePath = join(projectPath, "CLAUDE.md");
    const agentsPath = join(projectPath, "AGENTS.md");
    const cursorPath = join(projectPath, ".cursor", "rules", "architecture-tracker.mdc");

    if (existsSync(claudePath)) {
      if (archExisted) filesModified.push("CLAUDE.md");
      else filesCreated.push("CLAUDE.md");
    }
    if (existsSync(agentsPath)) {
      if (archExisted) filesModified.push("AGENTS.md");
      else filesCreated.push("AGENTS.md");
    }
    if (existsSync(cursorPath)) filesCreated.push(".cursor/rules/architecture-tracker.mdc");

    return jsonResult({ success: true, filesCreated, filesModified, filesSkipped });
  } catch (err) {
    return errorResult(`Failed to scaffold project: ${(err as Error).message}`);
  }
}

export async function handleOpenViewer(
  dir: string,
  input: z.input<typeof OpenViewerInputSchema>
): Promise<CallToolResult> {
  const { existsSync } = await import("node:fs");

  const archPath = architecturePath(dir);
  if (!existsSync(archPath)) {
    return errorResult(`arkive/architecture.json not found at ${archPath}. Run scaffold_project first.`);
  }

  const port = input.port ?? 4567;

  // The viewer server requires a per-run bearer token on every `/api/*` request,
  // so a bare `http://localhost:${port}` 401s on every call. The token rides in
  // the URL fragment, which `viewerUrl` builds and the viewer reads on load.
  // See docs/issues/0017-close-auth-followups.md.
  if (activeViewerServer && activeViewerServer.port === port) {
    const { viewerUrl } = await import("../cli/commands/serve.js");
    return jsonResult({
      url: viewerUrl(port, activeViewerServer.token),
      port,
      alreadyRunning: true,
    });
  }

  try {
    const { createViewerServer, viewerUrl } = await import("../cli/commands/serve.js");
    const { server, token } = createViewerServer(dir);

    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(port, () => resolve());
    });

    activeViewerServer = { server, port, token };

    return jsonResult({ url: viewerUrl(port, token), port, alreadyRunning: false });
  } catch (err) {
    return errorResult(`Failed to start viewer: ${(err as Error).message}`);
  }
}

export async function handleListPrompts(
  dir: string,
  input: z.infer<typeof ListPromptsInputSchema>
): Promise<CallToolResult> {
  const read = readPromptQueue(dir);
  if (!read.success) return errorResult(read.error);

  const queue = read.data;
  const filtered = input.status
    ? queue.prompts.filter((p) => p.status === input.status)
    : queue.prompts;

  return jsonResult({
    prompts: filtered,
    total: queue.prompts.length,
    pending: queue.prompts.filter((p) => p.status === "pending").length,
    claimed: queue.prompts.filter((p) => p.status === "claimed").length,
  });
}

export async function handleClaimNextPrompt(
  dir: string,
  input: z.infer<typeof ClaimNextPromptInputSchema>
): Promise<CallToolResult> {
  const result = claimNextPrompt(dir, input.agent);
  if (!result.success) return errorResult(result.error);

  if (result.data === null) {
    return jsonResult({ claimed: false, prompt: null, message: "No pending prompts in queue" });
  }

  return jsonResult({ claimed: true, prompt: result.data });
}

export async function handleAckPrompt(
  dir: string,
  input: z.infer<typeof AckPromptInputSchema>
): Promise<CallToolResult> {
  const fn = input.outcome === "done" ? ackPrompt : failPrompt;
  const result = fn(dir, input.promptId);
  if (!result.success) return errorResult(result.error);

  return jsonResult({ ok: true, promptId: input.promptId, outcome: input.outcome });
}

/**
 * The consolidated prompt-queue handler (issue 0009).
 *
 * Dispatches on the `action` discriminator to the three prompt operations
 * above, whose behaviors are unchanged. Takes raw input and validates it
 * against {@link PromptsInputSchema} itself, so a caller that sends an
 * unknown action or an `ack` without a `promptId` gets an `isError` result
 * rather than an SDK-level rejection.
 */
export async function handlePrompts(dir: string, raw: unknown): Promise<CallToolResult> {
  const parsed = PromptsInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResult(
      `Invalid prompts input: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
    );
  }
  const input = parsed.data;
  switch (input.action) {
    case "list":
      return handleListPrompts(dir, { status: input.status });
    case "claim":
      return handleClaimNextPrompt(dir, { agent: input.agent });
    case "ack":
      return handleAckPrompt(dir, { promptId: input.promptId, outcome: input.outcome });
  }
}

// --- walkthrough ------------------------------------------------------------
//
// Issue 0009, ADR-0003 §The mechanism. The `walkthrough` tool is a thin
// transport shell: it reads the architecture document and delegates each
// action to the walkthrough engine (`src/walkthrough/`) through the narrow
// interface below.
//
// The engine speaks domain results (`{ found: true, ... }` /
// `{ found: false, ... }`), not the transport union — `asEngineResult`
// translates a miss into `{ success: false }` so a bad ref surfaces as
// `isError`, and `flattenWalkthroughGroups` renders the engine's
// kind-grouped edges as the flat arrays the MCP contract promises.

export type WalkthroughEngineResult =
  | { success: true; data: unknown }
  | { success: false; error: string };

/** The narrow interface the `walkthrough` tool delegates through. */
export interface WalkthroughEngine {
  topology(doc: ArchitectureDocument): WalkthroughEngineResult;
  open(doc: ArchitectureDocument, ref: string, depth: number): WalkthroughEngineResult;
  trace(doc: ArchitectureDocument, entryRef: string, exitRef: string): WalkthroughEngineResult;
}

interface WalkthroughEngineModule {
  topology?: (doc: ArchitectureDocument) => unknown;
  open?: (doc: ArchitectureDocument, ref: string, depth: number) => unknown;
  trace?: (doc: ArchitectureDocument, entryRef: string, exitRef: string) => unknown;
  walkthroughEngine?: WalkthroughEngine;
  default?: WalkthroughEngine | WalkthroughEngineModule;
}

let walkthroughEngineOverride: WalkthroughEngine | null = null;

/**
 * Test seam for the pending engine wiring. Tests inject a stub so the
 * delegation is real even while `src/walkthrough/index.js` does not exist.
 * Pass `null` to restore lazy loading.
 */
export function __setWalkthroughEngineForTests(engine: WalkthroughEngine | null): void {
  walkthroughEngineOverride = engine;
}

/** Normalize whatever the engine returns into the result union. */
function asEngineResult(value: unknown): WalkthroughEngineResult {
  if (typeof value === "object" && value !== null && "success" in value) {
    const record = value as { success: unknown; data?: unknown; error?: unknown };
    if (record.success === true) return { success: true, data: record.data };
    if (record.success === false) {
      return {
        success: false,
        error:
          typeof record.error === "string"
            ? record.error
            : "walkthrough engine returned an error with no message",
      };
    }
  }
  // The engine's domain misses carry no `success` key: `{ found: false }`
  // with the explanation in `reason` (trace) or `notes` (open). A miss is an
  // MCP error, never a successful empty answer — without this branch a bad
  // ref surfaced as success with no `isError`, which is the "invented path"
  // failure 0009 exists to prevent.
  if (typeof value === "object" && value !== null && "found" in value) {
    const record = value as { found: unknown; reason?: unknown; notes?: unknown };
    if (record.found === false) {
      const parts: string[] = [];
      if (typeof record.reason === "string" && record.reason.length > 0) parts.push(record.reason);
      if (Array.isArray(record.notes)) {
        for (const note of record.notes) {
          if (typeof note === "string" && note.length > 0) parts.push(note);
        }
      }
      return {
        success: false,
        error:
          parts.length > 0
            ? parts.join(" ")
            : "walkthrough engine found nothing for this query — refusing to invent one",
      };
    }
  }
  return { success: true, data: value };
}

function isWalkthroughEngine(candidate: unknown): candidate is WalkthroughEngine {
  if (typeof candidate !== "object" || candidate === null) return false;
  const record = candidate as Record<string, unknown>;
  return (
    typeof record.topology === "function" &&
    typeof record.open === "function" &&
    typeof record.trace === "function"
  );
}

async function loadWalkthroughEngine(): Promise<WalkthroughEngine> {
  if (walkthroughEngineOverride) return walkthroughEngineOverride;
  // The engine is a sibling module compiled into the same build — a failed
  // import is a broken build, and failing loudly beats serving a stopgap.
  const WALKTHROUGH_ENGINE_MODULE = "../walkthrough/index.js";
  const mod = (await import(WALKTHROUGH_ENGINE_MODULE)) as WalkthroughEngineModule;
  const candidate = mod.walkthroughEngine ?? mod.default;
  if (isWalkthroughEngine(candidate)) return candidate;
  if (
    typeof mod.topology === "function" &&
    typeof mod.open === "function" &&
    typeof mod.trace === "function"
  ) {
    const { topology, open, trace } = mod;
    return {
      topology: (doc) => asEngineResult(topology(doc)),
      open: (doc, ref, depth) => asEngineResult(open(doc, ref, depth)),
      trace: (doc, entryRef, exitRef) => asEngineResult(trace(doc, entryRef, exitRef)),
    };
  }
  throw new Error(
    `walkthrough engine module "${WALKTHROUGH_ENGINE_MODULE}" does not export ` +
      `topology/open/trace (named) or a walkthroughEngine/default engine object.`
  );
}

/**
 * The engine groups `open` edges by kind (`Record<kind, EdgeEntry[]>`); the
 * MCP contract is flat arrays. Flatten in place so the tool shape stays
 * stable whatever the engine's internal grouping is — the entries themselves
 * are untouched.
 */
function flattenWalkthroughGroups(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return data;
  const record = data as Record<string, unknown>;
  let changed = false;
  const out = { ...record };
  for (const key of ["inbound", "outbound"] as const) {
    const groups = record[key];
    if (groups === undefined || Array.isArray(groups)) continue;
    if (typeof groups !== "object" || groups === null) continue;
    out[key] = (Object.values(groups) as unknown[][]).flat();
    changed = true;
  }
  return changed ? out : data;
}

/**
 * The walkthrough handler (issue 0009).
 *
 * Validates raw input against {@link WalkthroughInputSchema} (so `open`
 * without a `ref`, or with `depth` above 3, is an `isError` result), reads the
 * architecture document, and delegates to the walkthrough engine loaded by
 * {@link loadWalkthroughEngine}. Engine errors surface as `isError` — a bad
 * ref never produces an invented path.
 */
export async function handleWalkthrough(dir: string, raw: unknown): Promise<CallToolResult> {
  const parsed = WalkthroughInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResult(
      `Invalid walkthrough input: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
    );
  }
  const read = readArchitecture(dir);
  if (!read.success) return errorResult(read.error);

  const engine = await loadWalkthroughEngine();
  const input = parsed.data;
  const result =
    input.action === "topology"
      ? engine.topology(read.data)
      : input.action === "open"
        ? engine.open(read.data, input.ref, input.depth)
        : engine.trace(read.data, input.entryRef, input.exitRef);
  if (!result.success) return errorResult(result.error);
  return jsonResult(flattenWalkthroughGroups(result.data));
}

/**
 * Description for a registered tool, looked up by name rather than by
 * position. `ARCHITECTURE_TOOLS` is the single list of names; indexing it
 * positionally made every consolidation a renumbering exercise.
 */
function toolDescription(name: string): string {
  const found = ARCHITECTURE_TOOLS.find((tool) => tool.name === name);
  if (!found) throw new Error(`Unknown tool "${name}" — add it to ARCHITECTURE_TOOLS first.`);
  return found.description;
}

/**
 * Flat parameter shapes for the two action-discriminated tools.
 *
 * The SDK registers a record of fields, not a discriminated union, so each
 * tool declares every field its actions accept as optional here and the
 * handler validates the discriminator combination itself (a missing `ref` on
 * `open`, or a missing `promptId` on `ack`, is an `isError` result).
 */
const PromptsToolParams = {
  action: z.enum(["list", "claim", "ack"]).describe("Which prompt-queue operation to run"),
  status: z
    .enum(["pending", "claimed", "done", "failed"])
    .optional()
    .describe("list: filter by status (omit for all)"),
  agent: z.string().optional().describe("claim: agent identifier claiming the prompt"),
  promptId: z.string().optional().describe("ack: ID of the prompt to acknowledge"),
  outcome: z
    .enum(["done", "failed"])
    .optional()
    .describe("ack: whether the prompt was completed or failed"),
};

const WalkthroughToolParams = {
  action: z.enum(["topology", "open", "trace"]).describe("Which walkthrough query to run"),
  ref: z.string().optional().describe("open: node or edge id to open"),
  depth: z
    .number()
    .optional()
    .describe("open: directory hops below ref to include as children (default 1, max 3)"),
  entryRef: z.string().optional().describe("trace: node id the path starts at"),
  exitRef: z.string().optional().describe("trace: node id the path ends at"),
};

export function registerTools(server: McpServer, dir: string): void {
  server.tool(
    "update_architecture",
    toolDescription("update_architecture"),
    UpdateArchitectureInputSchema.shape,
    async (args) => {
      const result = await handleUpdateArchitecture(dir, args as unknown as z.infer<typeof UpdateArchitectureInputSchema>);
      return result;
    }
  );

  server.tool(
    "record_decision",
    toolDescription("record_decision"),
    RecordDecisionInputSchema.shape,
    async (args) => {
      const result = await handleRecordDecision(dir, args as unknown as z.infer<typeof RecordDecisionInputSchema>);
      return result;
    }
  );

  server.tool(
    "check_drift",
    toolDescription("check_drift"),
    CheckDriftInputSchema.shape,
    async () => {
      const result = await handleCheckDrift(dir);
      return result;
    }
  );

  server.tool(
    "scaffold_project",
    toolDescription("scaffold_project"),
    ScaffoldProjectInputSchema.shape,
    async (args) => {
      const result = await handleScaffoldProject(args as unknown as z.input<typeof ScaffoldProjectInputSchema>);
      return result;
    }
  );

  server.tool(
    "open_viewer",
    toolDescription("open_viewer"),
    OpenViewerInputSchema.shape,
    async (args) => {
      const result = await handleOpenViewer(dir, args as unknown as z.input<typeof OpenViewerInputSchema>);
      return result;
    }
  );

  server.tool(
    "prompts",
    toolDescription("prompts"),
    PromptsToolParams,
    async (args) => {
      const result = await handlePrompts(dir, args);
      return result;
    }
  );

  server.tool(
    "why_does_this_exist",
    toolDescription("why_does_this_exist"),
    WhyDoesThisExistInputSchema.shape,
    async (args) => {
      const result = await handleWhyDoesThisExist(
        dir,
        args as unknown as z.infer<typeof WhyDoesThisExistInputSchema>
      );
      return result;
    }
  );

  server.tool(
    "walkthrough",
    toolDescription("walkthrough"),
    WalkthroughToolParams,
    async (args) => {
      const result = await handleWalkthrough(dir, args);
      return result;
    }
  );
}
