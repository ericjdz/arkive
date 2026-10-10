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

export type Architecture = z.infer<typeof ArchitectureSchema>;
export type Service = z.infer<typeof ServiceSchema>;
export type ServiceType = z.infer<typeof ServiceTypeSchema>;
export type Connection = z.infer<typeof ConnectionSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type DataFlow = z.infer<typeof DataFlowSchema>;
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type Stack = z.infer<typeof StackSchema>;
