import type { ServiceType } from "../../../schema/types.js";

export interface Architecture {
  version: string;
  project: {
    name: string;
    description: string;
    created: string;
    lastUpdated: string;
  };
  stack: {
    language: string[];
    runtime: string[];
    framework: string[];
    database: string[];
    infrastructure: string[];
  };
  services: Service[];
  connections: Connection[];
  decisions: Decision[];
  dataFlows: DataFlow[];
  history: HistoryEntry[];
}

export interface Service {
  id: string;
  name: string;
  type: ServiceType;
  technology: string;
  description: string;
  ports?: string[];
  dependencies: string[];
}

export interface Connection {
  from: string;
  to: string;
  protocol: string;
  description: string;
}

export interface Decision {
  id: string;
  topic: string;
  decision: string;
  rationale: string;
  alternatives: { name: string; whyNot: string }[];
  timestamp: string;
  relatedServices: string[];
}

export interface DataFlow {
  name: string;
  steps: { actor: string; action: string }[];
}

export interface HistoryEntry {
  timestamp: string;
  action: string;
  summary: string;
  agent?: string;
}

export async function fetchArchitecture(): Promise<Architecture> {
  const response = await fetch("/api/architecture");
  if (!response.ok) {
    throw new Error(`Failed to fetch architecture: ${response.status} ${response.statusText}`);
  }
  return response.json();
}
