export { ArchitectureSchema } from "./schema/architecture.js";
export { validateArchitecture, createEmptyArchitecture } from "./schema/validate.js";
export type { Architecture, Service, Connection, Decision, DataFlow } from "./schema/types.js";

// Graph schema v2 (docs/issues/0003-graph-schema-v2.md). Persistence and the
// `services` projection land in 0004; the schema and the v1 -> v2 migration are
// pure and usable today.
export {
  CURRENT_SCHEMA_VERSION,
  NodeSchema,
  EdgeSchema,
  NodeKindSchema,
  EdgeKindSchema,
  DecisionSubjectSchema,
  GraphDocumentSchema,
  ArchitectureDocumentV2Schema,
  ProvenanceSchema,
  DerivedProvenanceSchema,
  AuthoredProvenanceSchema,
  validateGraphDocument,
  createEmptyArchitectureV2,
  detectSchemaVersion,
  migrateDocument,
  migrateV1ToV2,
  MIGRATIONS,
} from "./schema/index.js";
export type {
  ArchitectureDocumentV2,
  GraphDocument,
  GraphNode,
  GraphEdge,
  NodeKind,
  EdgeKind,
  DecisionSubject,
  Provenance,
} from "./schema/index.js";
