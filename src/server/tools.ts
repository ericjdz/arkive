import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readArchitecture, writeArchitecture } from "../io/architecture-file.js";
import {
  ServiceSchema,
  ConnectionSchema,
  DataFlowSchema,
  AlternativeSchema,
} from "../schema/architecture.js";
import type { Architecture, Decision } from "../schema/types.js";

export const UpdateArchitectureInputSchema = z.object({
  summary: z.string().min(1).describe("One-line summary of what changed (added to history)"),
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

export const RecordDecisionInputSchema = z.object({
  topic: z.string().min(1),
  decision: z.string().min(1),
  rationale: z.string().min(1),
  alternatives: z.array(AlternativeSchema).min(1),
  relatedServices: z.array(z.string()).default([]),
  agent: z.string().optional(),
});

export const CheckDriftInputSchema = z.object({});

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
      "Merge new services, connections, data flows, or stack entries into architecture.json. Validates against the schema before writing.",
  },
  {
    name: "record_decision",
    title: "Record Decision",
    description:
      "Append a new architectural decision with rationale and rejected alternatives.",
  },
  {
    name: "check_drift",
    title: "Check Drift",
    description:
      "Run static analysis on package.json and source imports; report mismatches against architecture.json.",
  },
];

interface CallToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

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

function mergeUnique(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b]));
}

function nextDecisionId(existing: Decision[]): string {
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

export async function handleUpdateArchitecture(
  dir: string,
  input: z.infer<typeof UpdateArchitectureInputSchema>
): Promise<CallToolResult> {
  const read = readArchitecture(dir);
  if (!read.success) return errorResult(read.error);

  const arch: Architecture = read.data;
  const now = new Date().toISOString();

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

  arch.history.push({
    timestamp: now,
    action: "update_architecture",
    summary: input.summary,
    agent: input.agent,
  });

  const write = writeArchitecture(dir, arch);
  if (!write.success) return errorResult(write.error);

  return jsonResult({
    ok: true,
    summary: input.summary,
    counts: {
      services: write.data.services.length,
      connections: write.data.connections.length,
      dataFlows: write.data.dataFlows.length,
      decisions: write.data.decisions.length,
    },
  });
}

export async function handleRecordDecision(
  dir: string,
  input: z.infer<typeof RecordDecisionInputSchema>
): Promise<CallToolResult> {
  const read = readArchitecture(dir);
  if (!read.success) return errorResult(read.error);

  const arch: Architecture = read.data;
  const serviceIds = new Set(arch.services.map((s) => s.id));
  const unknownRelated = input.relatedServices.filter((id) => !serviceIds.has(id));
  if (unknownRelated.length > 0) {
    return errorResult(`Unknown relatedServices ids: ${unknownRelated.join(", ")}`);
  }

  const now = new Date().toISOString();

  const decision: Decision = {
    id: nextDecisionId(arch.decisions),
    topic: input.topic,
    decision: input.decision,
    rationale: input.rationale,
    alternatives: input.alternatives,
    timestamp: now,
    relatedServices: input.relatedServices,
  };

  arch.decisions.push(decision);
  arch.history.push({
    timestamp: now,
    action: "architecture_decision",
    summary: `${input.topic}: ${input.decision}`,
    agent: input.agent,
  });

  const write = writeArchitecture(dir, arch);
  if (!write.success) return errorResult(write.error);

  return jsonResult({ ok: true, decision });
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

export function registerTools(server: McpServer, dir: string): void {
  server.tool(
    "update_architecture",
    ARCHITECTURE_TOOLS[0].description,
    UpdateArchitectureInputSchema.shape,
    async (args) => handleUpdateArchitecture(dir, args as unknown as z.infer<typeof UpdateArchitectureInputSchema>)
  );

  server.tool(
    "record_decision",
    ARCHITECTURE_TOOLS[1].description,
    RecordDecisionInputSchema.shape,
    async (args) => handleRecordDecision(dir, args as unknown as z.infer<typeof RecordDecisionInputSchema>)
  );

  server.tool(
    "check_drift",
    ARCHITECTURE_TOOLS[2].description,
    CheckDriftInputSchema.shape,
    async () => handleCheckDrift(dir)
  );
}
