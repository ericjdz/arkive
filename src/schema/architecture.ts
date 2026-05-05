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

export const ServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: ServiceTypeSchema,
  technology: z.string().min(1),
  description: z.string(),
  ports: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).default([]),
});

export const ConnectionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  protocol: z.string().min(1),
  description: z.string(),
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
  alternatives: z.array(AlternativeSchema).default([]),
  timestamp: z.string().datetime(),
  relatedServices: z.array(z.string()).default([]),
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
  services: z.array(ServiceSchema).default([]),
  connections: z.array(ConnectionSchema).default([]),
  decisions: z.array(DecisionSchema).default([]),
  dataFlows: z.array(DataFlowSchema).default([]),
  history: z.array(HistoryEntrySchema).default([]),
});
