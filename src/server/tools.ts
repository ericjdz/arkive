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
  removeServiceIds: z.array(z.string()).optional().describe("Service IDs to remove"),
  removeConnectionKeys: z.array(z.string()).optional().describe("Connection keys to remove (format: 'from->to:protocol')"),
  removeDataFlowNames: z.array(z.string()).optional().describe("Data flow names to remove"),
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

export const ScaffoldProjectInputSchema = z.object({
  projectPath: z.string().min(1).describe("Absolute path to the project root"),
  projectName: z.string().optional().describe("Project name (defaults to directory name)"),
  standalone: z.boolean().optional().default(false).describe("Generate full instruction files instead of injecting blocks"),
});

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
  {
    name: "scaffold_project",
    title: "Scaffold Project",
    description:
      "Initialize arkive in a project directory. Creates architecture.json and injects tracking blocks into instruction files.",
  },
];

interface CallToolResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
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

  if (input.removeServiceIds) {
    const toRemove = new Set(input.removeServiceIds);
    arch.services = arch.services.filter((s) => !toRemove.has(s.id));
    arch.connections = arch.connections.filter(
      (c) => !toRemove.has(c.from) && !toRemove.has(c.to)
    );
    for (const s of arch.services) {
      s.dependencies = s.dependencies.filter((d) => !toRemove.has(d));
    }
  }

  if (input.removeConnectionKeys) {
    const toRemove = new Set(input.removeConnectionKeys);
    const connKey = (c: { from: string; to: string; protocol: string }) =>
      `${c.from}->${c.to}:${c.protocol}`;
    arch.connections = arch.connections.filter((c) => !toRemove.has(connKey(c)));
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

export async function handleScaffoldProject(
  input: z.infer<typeof ScaffoldProjectInputSchema>
): Promise<CallToolResult> {
  try {
    const { initProject } = await import("../cli/commands/init.js");
    const { basename, join } = await import("node:path");
    const { existsSync } = await import("node:fs");

    const projectPath = input.projectPath;
    const archPath = join(projectPath, "architecture.json");
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
      filesSkipped.push("architecture.json");
    } else {
      filesCreated.push("architecture.json");
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

export function registerTools(server: McpServer, dir: string): void {
  server.tool(
    "update_architecture",
    ARCHITECTURE_TOOLS[0].description,
    UpdateArchitectureInputSchema.shape,
    async (args) => {
      const result = await handleUpdateArchitecture(dir, args as unknown as z.infer<typeof UpdateArchitectureInputSchema>);
      return result;
    }
  );

  server.tool(
    "record_decision",
    ARCHITECTURE_TOOLS[1].description,
    RecordDecisionInputSchema.shape,
    async (args) => {
      const result = await handleRecordDecision(dir, args as unknown as z.infer<typeof RecordDecisionInputSchema>);
      return result;
    }
  );

  server.tool(
    "check_drift",
    ARCHITECTURE_TOOLS[2].description,
    CheckDriftInputSchema.shape,
    async () => {
      const result = await handleCheckDrift(dir);
      return result;
    }
  );

  server.tool(
    "scaffold_project",
    ARCHITECTURE_TOOLS[3].description,
    ScaffoldProjectInputSchema.shape,
    async (args) => {
      const result = await handleScaffoldProject(args as unknown as z.infer<typeof ScaffoldProjectInputSchema>);
      return result;
    }
  );
}
