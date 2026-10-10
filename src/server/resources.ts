import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { readArchitecture } from "../io/architecture-file.js";
import type { ArchitectureDocument } from "../io/architecture-file.js";
import { readPromptQueue } from "../io/prompt-queue.js";
import { buildSessionContext } from "./session-context.js";
import { CURRENT_SCHEMA_VERSION } from "../schema/graph.js";

export interface ArchitectureResourceDescriptor {
  name: string;
  uri: string;
  title: string;
  description: string;
  mimeType?: string;
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
  {
    name: "architecture-hooks",
    uri: "architecture://hooks",
    title: "Lifecycle Hooks",
    description:
      "Lifecycle rules for maintaining arkive/architecture.json: session_start, post_major_change, pre_completion.",
    mimeType: "text/markdown",
  },
  {
    name: "architecture-prompts",
    uri: "architecture://prompts",
    title: "Prompt Queue",
    description:
      "User-queued prompts from the architecture viewer, scoped to specific services. Agents can read pending prompts and claim them for execution.",
  },
  {
    name: "architecture-session-context",
    uri: "architecture://session-context",
    title: "Session Context",
    description:
      "Compact, token-budgeted summary of the architecture optimized for session start injection. Returns markdown, not raw JSON. Use this instead of reading the full architecture when context window is limited.",
    mimeType: "text/markdown",
  },
];

function loadOrThrow(dir: string): ArchitectureDocument {
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
    // `schemaVersion`, not `version`. `version` was a defaulted semver string
    // that nothing branched on and that only ever got echoed back here
    // (ADR-0001:121-127); a caller that wants to know whether this document has
    // been migrated needs the field that actually gates the migration.
    schemaVersion: arch.schemaVersion,
    // `version === "1.0.0"` means the file on disk still has no `schemaVersion`.
    // It is in memory as v2; only a write persists that (issue 0004 §3 — a read
    // never rewrites the file).
    pendingMigration: arch.version === "1.0.0",
    currentSchemaVersion: CURRENT_SCHEMA_VERSION,
    project: arch.project,
    stack: arch.stack,
    counts: {
      nodes: arch.nodes.length,
      edges: arch.edges.length,
      /** The deprecated v1 view, kept so existing clients see the same shape. */
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
  // The projection, not the graph. ADR-0001:90-104 — the resource *shape* is
  // unchanged even though the storage shape is not, which is what keeps every
  // existing client working while consumers migrate. `nodes`/`edges` are
  // included so a caller that has moved to v2 can stop reading a projection.
  return jsonResource(uri, {
    _deprecated:
      "services/connections are a computed projection of nodes/edges. Edit the " +
      "graph; read nodes/edges if you have migrated.",
    nodes: arch.nodes,
    edges: arch.edges,
    services: arch.services,
    connections: arch.connections,
  });
}

export async function readDecisions(
  dir: string,
  uri: URL
): Promise<ReadResourceResult> {
  const arch = loadOrThrow(dir);
  // Each decision carries both `subjects` (v2, authoritative) and
  // `relatedServices` (projected from the node subjects) so a v1 consumer keeps
  // reading the same field.
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

export async function readHooks(
  _dir: string,
  uri: URL
): Promise<ReadResourceResult> {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: `# arkive Lifecycle Hooks

## session_start
On EVERY session start, BEFORE any other action:
1. Check if arkive/architecture.json exists in the project.
2. If it exists: read it completely. This is your cross-session memory. Do NOT re-derive architecture from code.
3. If it does not exist: inform the user that arkive is not initialized. Suggest running arkive init.
4. Check if arkive/prompt-queue.json exists. If it has pending prompts, inform the user: "There are N pending architecture prompts from the viewer. Use list_prompts to see them, or claim_next_prompt to start executing."

## post_major_change
After ANY major change (adding/removing services, changing protocols, new frameworks, infrastructure changes, module boundary refactors):
1. Re-read architecture.json to get current state.
2. Call update_architecture with changes.
3. Call record_decision for any architectural choices made.
4. Append a history entry.
5. Do NOT defer this to "later" — update IMMEDIATELY after the change.

## pre_completion
Before claiming work is complete, before committing, before creating PRs:
1. Re-read architecture.json.
2. Verify it reflects the current state of the project.
3. If any architectural changes were made that are not reflected: update now.
4. Call check_drift and resolve any mismatches.
`,
      },
    ],
  };
}

export async function readPrompts(
  dir: string,
  uri: URL
): Promise<ReadResourceResult> {
  const read = readPromptQueue(dir);
  const queue = read.success ? read.data : { prompts: [] };
  return jsonResource(uri, {
    prompts: queue.prompts,
    total: queue.prompts.length,
    pending: queue.prompts.filter((p) => p.status === "pending").length,
    claimed: queue.prompts.filter((p) => p.status === "claimed").length,
  });
}

export async function readSessionContext(
  dir: string,
  uri: URL
): Promise<ReadResourceResult> {
  const arch = loadOrThrow(dir);
  const context = buildSessionContext(arch);
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: context,
      },
    ],
  };
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
  "architecture://hooks": readHooks,
  "architecture://prompts": readPrompts,
  "architecture://session-context": readSessionContext,
};

export function registerResources(server: McpServer, dir: string): void {
  for (const descriptor of ARCHITECTURE_RESOURCES) {
    const handler = HANDLERS[descriptor.uri];
    server.resource(
      descriptor.name,
      descriptor.uri,
      {
        description: descriptor.description,
        mimeType: descriptor.mimeType ?? "application/json",
      },
      async (uri) => handler(dir, uri)
    );
  }
}
