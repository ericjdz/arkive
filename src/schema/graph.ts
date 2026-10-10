import { z } from "zod";
import { ProvenanceSchema, TimestampSchema } from "./provenance.js";

/**
 * The v2 graph document (`docs/adr/0001-graph-first-architecture-document.md`).
 *
 * Two design rules hold everywhere in this file and must survive future edits:
 *
 * 1. **No `.default()` anywhere.** ADR-0006 rejects `.passthrough()` because
 *    "the read still returns a Zod-reconstructed object with defaulted fields
 *    materialised into it, so a future schema default silently writes itself
 *    into the user's document". A defaultless schema removes that objection
 *    entirely: `parse(x)` is deep-equal to `x`, so `looseObject` costs nothing
 *    and buys unknown-key survival even for a caller that persists the parsed
 *    output. `tests/schema/preserve-unknown-keys.test.ts` asserts this.
 * 2. **Every user-extensible container is `looseObject`** (ADR-0006 §3).
 *
 * Names here carry a `Graph` prefix where a v1 schema of the same meaning
 * exists (`architecture.ts`). Two exports called `DecisionSchema` meaning
 * different shapes in one package is a footgun, and `src/schema/index.ts`
 * re-exports both modules.
 */

/** The schema version this build reads and writes. */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * Node kinds. The v1 `ServiceTypeSchema` enum (`frontend`, `cache`, `queue`,
 * …) is deliberately not carried forward: it is a taxonomy of deployment
 * concerns that overlaps `kind` and answers no structural question
 * (ADR-0001:65-68). A cache is a `datastore`; a queue is a `datastore` with an
 * `endpoint` on it.
 */
export const NodeKindSchema = z.enum([
  "module",
  "service",
  "datastore",
  "external",
  "datastructure",
  "endpoint",
]);

/**
 * Edge kinds. `label` is transport naming only (`"HTTP/REST"`, `"stdio"`,
 * `"TCP/SQL"`) and is never used for semantics — `kind` is (ADR-0001:74-76).
 *
 * `decided_by` is in the enum because the projection has to validate against
 * `EdgeSchema`, but it is never stored: it is emitted by joining
 * `decision.subjects` against the graph (ADR-0001:78-88).
 */
export const EdgeKindSchema = z.enum([
  "imports",
  "calls",
  "reads",
  "writes",
  "derives_from",
  "decided_by",
]);

export const NodeSchema = z.looseObject({
  id: z.string().min(1),
  kind: NodeKindSchema,
  name: z.string().min(1),
  /**
   * Required, and possibly empty. v1's `ServiceSchema.description` is
   * `z.string()` with no `min(1)`, so the migration has no non-empty value to
   * carry for every service; making it optional would hide the emptiness.
   */
  summary: z.string(),
  /** Implementation technology, where one applies. */
  tech: z.string().optional(),
  /** Filesystem path. Meaningful for `kind: "module"`. */
  path: z.string().optional(),
  /** Carried over from v1 `ServiceSchema.ports`. */
  ports: z.array(z.string()).optional(),
  /** Free-text owner. Set by humans, read by nobody — deliberately. */
  owner: z.string().optional(),
  /**
   * Tombstone. ADR-0001:106-117 requires node removal to be a soft delete in
   * one transactional write: set `deletedAt`, drop incident edges, leave
   * decisions untouched. `0004` implements the transaction; the field is here
   * so a tombstoned node round-trips without being read as a live one.
   */
  deletedAt: TimestampSchema.optional(),
  provenance: ProvenanceSchema,
});

export const EdgeSchema = z.looseObject({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: EdgeKindSchema,
  /** Transport naming only. Never semantic. */
  label: z.string().optional(),
  /** Human note. Not consumed by any traversal. */
  note: z.string().optional(),
  /**
   * Marks an edge whose endpoints do not resolve. `migrateV1ToV2` sets it when a
   * v1 `connections[]` entry pointed at a service id that no longer exists, so
   * the dangling reference is preserved rather than dropped
   * (ADR-0001:141-145). Semantic validation reports these instead of
   * rejecting them.
   */
  dangling: z.boolean().optional(),
  provenance: ProvenanceSchema,
});

export const DecisionSubjectSchema = z.looseObject({
  kind: z.enum(["node", "edge"]),
  ref: z.string().min(1),
});

export const GraphAlternativeSchema = z.looseObject({
  name: z.string().min(1),
  whyNot: z.string().min(1),
});

export const GraphDecisionSchema = z.looseObject({
  id: z.string().min(1),
  topic: z.string().min(1),
  decision: z.string().min(1),
  rationale: z.string().min(1),
  alternatives: z.array(GraphAlternativeSchema).min(1),
  timestamp: TimestampSchema,
  /**
   * Replaces v1's `relatedServices: string[]`. Unresolvable refs are preserved
   * rather than dropped: `record_decision` accepted them before the graph
   * existed, and dropping them is the same class of silent loss as `62066bc`
   * (ADR-0001:146-149). Validation reports them as warnings.
   */
  subjects: z.array(DecisionSubjectSchema),
});

export const GraphDataFlowStepSchema = z.looseObject({
  actor: z.string().min(1),
  action: z.string().min(1),
});

export const GraphDataFlowSchema = z.looseObject({
  name: z.string().min(1),
  steps: z.array(GraphDataFlowStepSchema).min(1),
});

export const GraphHistoryEntrySchema = z.looseObject({
  timestamp: TimestampSchema,
  action: z.string().min(1),
  summary: z.string().min(1),
  agent: z.string().optional(),
});

export const GraphProjectSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string(),
  created: TimestampSchema,
  lastUpdated: TimestampSchema,
});

/**
 * Defaultless by rule 1: a stack with no `database` key has no `database` key,
 * and a write does not invent one.
 */
export const GraphStackSchema = z.looseObject({
  language: z.array(z.string()),
  runtime: z.array(z.string()),
  framework: z.array(z.string()),
  database: z.array(z.string()),
  infrastructure: z.array(z.string()),
});

/**
 * The graph container. `schemaVersion` is `z.number().int()` with **no
 * default**, which is the whole safety mechanism for ADR-0006's probe: a v1
 * document (`version: "1.0.0"`, no `schemaVersion`) fails to parse
 * immediately and loudly rather than being accepted by the wrong reader. The
 * v1 field was `z.string().default("1.0.0")` — defaulted, never read as a
 * discriminator, only echoed back at `src/server/resources.ts:100`. A semver
 * string with a default is the worst of both.
 */
export const GraphDocumentSchema = z.looseObject({
  schemaVersion: z.number().int(),
  project: GraphProjectSchema,
  stack: GraphStackSchema,
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  decisions: z.array(GraphDecisionSchema),
  dataFlows: z.array(GraphDataFlowSchema),
  history: z.array(GraphHistoryEntrySchema),
});

/**
 * The version gate: `schemaVersion` must be exactly `CURRENT_SCHEMA_VERSION`,
 * so an unknown major is a hard parse error reported at `schemaVersion`,
 * never a best-effort parse (ADR-0001:132).
 */
export const ArchitectureDocumentV2Schema = GraphDocumentSchema.extend({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
});

export type ArchitectureDocumentV2 = z.infer<typeof ArchitectureDocumentV2Schema>;
/** Version-agnostic container, for the probe in `migrate.ts`. */
export type GraphDocument = z.infer<typeof GraphDocumentSchema>;
export type GraphNode = z.infer<typeof NodeSchema>;
export type GraphEdge = z.infer<typeof EdgeSchema>;
export type NodeKind = z.infer<typeof NodeKindSchema>;
export type EdgeKind = z.infer<typeof EdgeKindSchema>;
export type DecisionSubject = z.infer<typeof DecisionSubjectSchema>;
export type GraphDecision = z.infer<typeof GraphDecisionSchema>;
export type GraphAlternative = z.infer<typeof GraphAlternativeSchema>;
export type GraphDataFlow = z.infer<typeof GraphDataFlowSchema>;
export type GraphDataFlowStep = z.infer<typeof GraphDataFlowStepSchema>;
export type GraphHistoryEntry = z.infer<typeof GraphHistoryEntrySchema>;
export type GraphProject = z.infer<typeof GraphProjectSchema>;
export type GraphStack = z.infer<typeof GraphStackSchema>;

/** Node kinds whose derivation is fully mechanical (ADR-0002:62-69). */
export const DERIVED_NODE_KINDS: readonly NodeKind[] = [
  "module",
  "external",
  "datastructure",
];

/** Node kinds that need a human judgement call before they can be derived. */
export const HYBRID_NODE_KINDS: readonly NodeKind[] = [
  "service",
  "datastore",
  "endpoint",
];

/**
 * Edge kinds `migrateV1ToV2` may emit.
 *
 * `decided_by` is excluded on purpose: it is a projection of
 * `decision.subjects`, emitted by joining against the graph and never stored
 * (ADR-0001:78-88). Keeping it out makes "am I authoring a derived edge?" a
 * compile-time question rather than a review comment.
 */
export type StorableEdgeKind = Exclude<EdgeKind, "decided_by">;
