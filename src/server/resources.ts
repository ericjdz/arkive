import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { readArchitecture } from "../io/architecture-file.js";
import type { Architecture } from "../schema/types.js";

export interface ArchitectureResourceDescriptor {
  name: string;
  uri: string;
  title: string;
  description: string;
}

export const ARCHITECTURE_RESOURCES: ArchitectureResourceDescriptor[] = [
  {
    name: "architecture-overview",
    uri: "architecture://overview",
    title: "Architecture Overview",
    description:
      "Project metadata, technology stack, and counts of services/decisions/data flows.",
  },
  {
    name: "architecture-services",
    uri: "architecture://services",
    title: "Services and Connections",
    description: "All services in the system and how they communicate.",
  },
  {
    name: "architecture-decisions",
    uri: "architecture://decisions",
    title: "Architectural Decisions",
    description:
      "All recorded architectural decisions with rationale and rejected alternatives.",
  },
  {
    name: "architecture-dataflows",
    uri: "architecture://dataflows",
    title: "Data Flows",
    description: "Step-by-step user-facing data flows through the system.",
  },
  {
    name: "architecture-history",
    uri: "architecture://history",
    title: "Change History",
    description: "Chronological log of architectural changes.",
  },
];

function loadOrThrow(dir: string): Architecture {
  const result = readArchitecture(dir);
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.data;
}

function jsonResource(uri: URL, body: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(body, null, 2),
      },
    ],
  };
}

export async function readOverview(
  dir: string,
  uri: URL
): Promise<ReadResourceResult> {
  const arch = loadOrThrow(dir);
  return jsonResource(uri, {
    version: arch.version,
    project: arch.project,
    stack: arch.stack,
    counts: {
      services: arch.services.length,
      connections: arch.connections.length,
      decisions: arch.decisions.length,
      dataFlows: arch.dataFlows.length,
      history: arch.history.length,
    },
  });
}

export async function readServices(
  dir: string,
  uri: URL
): Promise<ReadResourceResult> {
  const arch = loadOrThrow(dir);
  return jsonResource(uri, {
    services: arch.services,
    connections: arch.connections,
  });
}

export async function readDecisions(
  dir: string,
  uri: URL
): Promise<ReadResourceResult> {
  const arch = loadOrThrow(dir);
  return jsonResource(uri, { decisions: arch.decisions });
}

export async function readDataflows(
  dir: string,
  uri: URL
): Promise<ReadResourceResult> {
  const arch = loadOrThrow(dir);
  return jsonResource(uri, { dataFlows: arch.dataFlows });
}

export async function readHistory(
  dir: string,
  uri: URL
): Promise<ReadResourceResult> {
  const arch = loadOrThrow(dir);
  return jsonResource(uri, { history: arch.history });
}

const HANDLERS: Record<
  string,
  (dir: string, uri: URL) => Promise<ReadResourceResult>
> = {
  "architecture://overview": readOverview,
  "architecture://services": readServices,
  "architecture://decisions": readDecisions,
  "architecture://dataflows": readDataflows,
  "architecture://history": readHistory,
};

export function registerResources(server: McpServer, dir: string): void {
  for (const descriptor of ARCHITECTURE_RESOURCES) {
    const handler = HANDLERS[descriptor.uri];
    server.resource(
      descriptor.name,
      descriptor.uri,
      {
        description: descriptor.description,
        mimeType: "application/json",
      },
      async (uri) => handler(dir, uri)
    );
  }
}
