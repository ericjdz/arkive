import type { Architecture } from "../schema/types.js";
import type { QuestionCategory } from "./types.js";

export interface ExtractedConcept {
  id: string;
  label: string;
  category: QuestionCategory;
  sourceId: string;
}

export function extractConcepts(arch: Architecture): ExtractedConcept[] {
  const concepts: ExtractedConcept[] = [];

  for (const decision of arch.decisions) {
    concepts.push({
      id: `concept-${decision.id}`,
      label: decision.topic,
      category: "decision",
      sourceId: decision.id,
    });
  }

  for (const service of arch.services) {
    concepts.push({
      id: `concept-svc-${service.id}`,
      label: `${service.name} (${service.type})`,
      category: "topology",
      sourceId: service.id,
    });
  }

  for (const conn of arch.connections) {
    concepts.push({
      id: `concept-conn-${conn.from}-${conn.to}`,
      label: `${conn.from} → ${conn.to} (${conn.protocol})`,
      category: "connection",
      sourceId: `${conn.from}-${conn.to}`,
    });
  }

  for (const flow of arch.dataFlows) {
    const slug = flow.name.toLowerCase().replace(/\s+/g, "-");
    concepts.push({
      id: `concept-flow-${slug}`,
      label: flow.name,
      category: "data-flow",
      sourceId: flow.name,
    });
  }

  return concepts;
}
