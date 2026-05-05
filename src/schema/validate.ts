import { ArchitectureSchema } from "./architecture.js";
import type { Architecture } from "./types.js";

type ValidationResult =
  | { success: true; data: Architecture }
  | { success: false; error: string };

export function validateArchitecture(data: unknown): ValidationResult {
  const parsed = ArchitectureSchema.safeParse(data);

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }

  const arch = parsed.data;

  const serviceIds = new Set(arch.services.map((s) => s.id));
  for (const conn of arch.connections) {
    if (!serviceIds.has(conn.from)) {
      return {
        success: false,
        error: `Connection references unknown service "${conn.from}"`,
      };
    }
    if (!serviceIds.has(conn.to)) {
      return {
        success: false,
        error: `Connection references unknown service "${conn.to}"`,
      };
    }
  }

  for (const service of arch.services) {
    for (const dep of service.dependencies) {
      if (!serviceIds.has(dep)) {
        return {
          success: false,
          error: `Service "${service.id}" depends on unknown service "${dep}"`,
        };
      }
    }
  }

  return { success: true, data: arch };
}

export function createEmptyArchitecture(
  name: string,
  description: string
): Architecture {
  const now = new Date().toISOString();
  return {
    version: "1.0.0",
    project: {
      name,
      description,
      created: now,
      lastUpdated: now,
    },
    stack: {
      language: [],
      runtime: [],
      framework: [],
      database: [],
      infrastructure: [],
    },
    services: [],
    connections: [],
    decisions: [],
    dataFlows: [],
    history: [
      {
        timestamp: now,
        action: "initial_scaffold",
        summary: `Architecture document created for ${name}`,
      },
    ],
  };
}
