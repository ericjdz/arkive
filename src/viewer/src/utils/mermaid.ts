interface Service {
  id: string;
  name: string;
  type: string;
  technology: string;
  description: string;
  dependencies: string[];
}

interface Connection {
  from: string;
  to: string;
  protocol: string;
  description: string;
}

interface DataFlow {
  name: string;
  steps: { actor: string; action: string }[];
}

function nodeShape(service: Service): string {
  const label = `${service.name}<br/><small>${service.technology}</small>`;
  switch (service.type) {
    case "database":
      return `${service.id}[("${label}")]`;
    case "frontend":
      return `${service.id}["${label}"]`;
    case "queue":
    case "cache":
      return `${service.id}[/"${label}"/]`;
    default:
      return `${service.id}["${label}"]`;
  }
}

export function generateMermaid(
  services: Service[],
  connections: Connection[],
  dataFlow?: DataFlow
): string {
  if (dataFlow) {
    return generateSequenceDiagram(services, dataFlow);
  }

  const lines: string[] = ["graph TD"];

  for (const service of services) {
    lines.push(`  ${nodeShape(service)}`);
  }

  for (const conn of connections) {
    lines.push(`  ${conn.from} -->|${conn.protocol}| ${conn.to}`);
  }

  return lines.join("\n");
}

function generateSequenceDiagram(
  services: Service[],
  dataFlow: DataFlow
): string {
  const nameMap = new Map(services.map((s) => [s.id, s.name]));
  const lines: string[] = ["sequenceDiagram"];

  const seen = new Set<string>();
  for (const step of dataFlow.steps) {
    if (!seen.has(step.actor)) {
      seen.add(step.actor);
      const name = nameMap.get(step.actor) ?? step.actor;
      lines.push(`  participant ${step.actor} as ${name}`);
    }
  }

  for (let i = 0; i < dataFlow.steps.length; i++) {
    const step = dataFlow.steps[i];
    const nextActor =
      i + 1 < dataFlow.steps.length
        ? dataFlow.steps[i + 1].actor
        : step.actor;
    if (nextActor !== step.actor) {
      lines.push(`  ${step.actor}->>+${nextActor}: ${step.action}`);
    } else {
      lines.push(`  Note over ${step.actor}: ${step.action}`);
    }
  }

  return lines.join("\n");
}
