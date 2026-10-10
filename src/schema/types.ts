import { z } from "zod";
import {
  ArchitectureSchema,
  ServiceSchema,
  ServiceTypeSchema,
  ConnectionSchema,
  DecisionSchema,
  DataFlowSchema,
  HistoryEntrySchema,
  ProjectSchema,
  StackSchema,
} from "./architecture.js";

/**
 * v1 document types.
 *
 * These stay exactly as they were. `version` is `z.string().default("1.0.0")`
 * and `ArchitectureSchema` strips unknown keys — both are fixed in v2
 * (`graph.ts`) and both fixes have to wait for `src/io/` to route reads through
 * the version probe, which is `0004`'s file.
 *
 * The v2 types are not re-exported from here: they live in `graph.ts`, which
 * owns them. Duplicating the names would make `export *` in
 * `src/schema/index.ts` ambiguous.
 */
export type Architecture = z.infer<typeof ArchitectureSchema>;
export type Service = z.infer<typeof ServiceSchema>;
export type ServiceType = z.infer<typeof ServiceTypeSchema>;
export type Connection = z.infer<typeof ConnectionSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type DataFlow = z.infer<typeof DataFlowSchema>;
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type Stack = z.infer<typeof StackSchema>;
