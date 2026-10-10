import { z } from "zod";

export const ServiceTypeSchema = z.enum([
  "frontend",
  "backend",
  "database",
  "cache",
  "queue",
  "gateway",
  "cdn",
  "storage",
  "auth",
  "search",
  "monitoring",
  "other",
]);

export const SourceSchema = z.enum([
  "agent-scanned",
  "human-verified",
  "inferred",
]);

export const ConfidenceSchema = z.number().min(0).max(1);

/**
 * @deprecated v1 service shape. Retained so `0004` can read and migrate every
 * document ever written. Superseded by `NodeSchema` in `graph.ts`.
 */
export const ServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: ServiceTypeSchema,
  technology: z.string().min(1),
  description: z.string(),
  ports: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).default([]),
  source: SourceSchema.optional(),
  confidence: ConfidenceSchema.optional(),
});

/**
 * @deprecated v1 connection shape. `protocol` is free text and carries no
 * semantics, which is the defect ADR-0001:22-31 names. Superseded by
 * `EdgeSchema`, where `kind` is the semantics and `label` is transport naming.
 */
export const ConnectionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  protocol: z.string().min(1),
  description: z.string(),
  source: SourceSchema.optional(),
  confidence: ConfidenceSchema.optional(),
});

export const AlternativeSchema = z.object({
  name: z.string().min(1),
  whyNot: z.string().min(1),
});

export const DecisionSchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  decision: z.string().min(1),
  rationale: z.string().min(1),
  alternatives: z.array(AlternativeSchema).min(1),
  timestamp: z.string().datetime(),
  relatedServices: z.array(z.string()).default([]),
  source: SourceSchema.optional(),
  confidence: ConfidenceSchema.optional(),
});

export const DataFlowStepSchema = z.object({
  actor: z.string().min(1),
  action: z.string().min(1),
});

export const DataFlowSchema = z.object({
  name: z.string().min(1),
  steps: z.array(DataFlowStepSchema).min(1),
});

export const HistoryEntrySchema = z.object({
  timestamp: z.string().datetime(),
  action: z.string().min(1),
  summary: z.string().min(1),
  agent: z.string().optional(),
});

export const ProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  created: z.string().datetime(),
  lastUpdated: z.string().datetime(),
});

export const StackSchema = z.object({
  language: z.array(z.string()).default([]),
  runtime: z.array(z.string()).default([]),
  framework: z.array(z.string()).default([]),
  database: z.array(z.string()).default([]),
  infrastructure: z.array(z.string()).default([]),
});

/**
 * The v1 document.
 *
 * @deprecated Superseded by `GraphDocumentSchema` in `graph.ts`. Everything
 * here is kept readable on purpose — `src/io/`, `src/server/`, `src/cli/`,
 * `src/analysis/` and the viewer still consume this shape until `0004` lands
 * the version probe and the `services` projection.
 *
 * Two v1 properties are deliberately *not* carried into v2, and neither is
 * changed here:
 *
 * - `version: z.string().default("1.0.0")` is decorative. Nothing has ever
 *   branched on document shape. v2 replaces it with a defaultless
 *   `schemaVersion: z.number().int()` (`graph.ts`), which makes a v1 file fail
 *   to parse under a v2 reader instead of parsing under the wrong one.
 * - `source` / `confidence` are inert — declared, read in two places, written
 *   by none. ADR-0002 deletes them.
 *
 * These schemas still strip unknown keys. They cannot stop doing so without
 * either loosening v1 (which would materialise every `.default()` into the
 * user's file on the next write — the failure ADR-0006:343-347 rejects) or
 * changing `src/io/architecture-file.ts` to persist the parsed object rather
 * than `validation.data` (`src/io/architecture-file.ts:63`, `:89`, `:169`).
 * Both are `0004` / `0013` work.
 */
export const ArchitectureSchema = z.object({
  version: z.string().default("1.0.0"),
  project: ProjectSchema,
  stack: StackSchema.default({
    language: [],
    runtime: [],
    framework: [],
    database: [],
    infrastructure: [],
  }),
  /** @deprecated Derived in v2 from `nodes` where `kind === "service"`. */
  services: z.array(ServiceSchema).default([]),
  /** @deprecated Derived in v2 from `edges`. */
  connections: z.array(ConnectionSchema).default([]),
  decisions: z.array(DecisionSchema).default([]),
  dataFlows: z.array(DataFlowSchema).default([]),
  history: z.array(HistoryEntrySchema).default([]),
});
