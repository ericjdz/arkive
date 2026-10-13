interface Architecture {
  version: string;
  project: { name: string; description: string; created: string; lastUpdated: string };
  stack: { language: string[]; runtime: string[]; framework: string[]; database: string[]; infrastructure: string[] };
  services: { id: string; name: string; type: string; technology: string; description: string; dependencies: string[] }[];
  connections: { from: string; to: string; protocol: string; description: string }[];
  decisions: { id: string; topic: string; decision: string; rationale: string; alternatives: { name: string; whyNot: string }[]; timestamp: string; relatedServices: string[] }[];
  dataFlows: { name: string; steps: { actor: string; action: string }[] }[];
  history: { timestamp: string; action: string; summary: string; agent?: string }[];
}

export function generateMarkdown(arch: Architecture): string {
  const lines: string[] = [];

  lines.push(`# ${arch.project.name}`);
  lines.push("");
  if (arch.project.description) {
    lines.push(`> ${arch.project.description}`);
    lines.push("");
  }

  lines.push("## Technology Stack");
  lines.push("");
  lines.push("| Category | Technologies |");
  lines.push("|---|---|");
  lines.push(`| Language | ${arch.stack.language.join(", ") || "—"} |`);
  lines.push(`| Runtime | ${arch.stack.runtime.join(", ") || "—"} |`);
  lines.push(`| Framework | ${arch.stack.framework.join(", ") || "—"} |`);
  lines.push(`| Database | ${arch.stack.database.join(", ") || "—"} |`);
  lines.push(`| Infrastructure | ${arch.stack.infrastructure.join(", ") || "—"} |`);
  lines.push("");

  if (arch.services.length > 0) {
    lines.push("## Services");
    lines.push("");
    lines.push("| Name | Type | Technology | Description | Dependencies |");
    lines.push("|---|---|---|---|---|");
    for (const s of arch.services) {
      lines.push(`| ${s.name} | ${s.type} | ${s.technology} | ${s.description} | ${s.dependencies.join(", ") || "—"} |`);
    }
    lines.push("");
  }

  if (arch.connections.length > 0) {
    lines.push("## Connections");
    lines.push("");
    lines.push("| From | To | Protocol | Description |");
    lines.push("|---|---|---|---|");
    for (const c of arch.connections) {
      lines.push(`| ${c.from} | ${c.to} | ${c.protocol} | ${c.description} |`);
    }
    lines.push("");
  }

  if (arch.decisions.length > 0) {
    lines.push("## Architectural Decisions");
    lines.push("");
    for (const d of arch.decisions) {
      lines.push(`### ${d.topic}`);
      lines.push("");
      lines.push(`**Decision:** ${d.decision}`);
      lines.push("");
      lines.push(`**Rationale:** ${d.rationale}`);
      lines.push("");
      if (d.alternatives.length > 0) {
        lines.push("**Alternatives considered:**");
        lines.push("");
        lines.push("| Alternative | Why not |");
        lines.push("|---|---|");
        for (const alt of d.alternatives) {
          lines.push(`| ${alt.name} | ${alt.whyNot} |`);
        }
        lines.push("");
      }
    }
  }

  if (arch.dataFlows.length > 0) {
    lines.push("## Data Flows");
    lines.push("");
    for (const flow of arch.dataFlows) {
      lines.push(`### ${flow.name}`);
      lines.push("");
      for (let i = 0; i < flow.steps.length; i++) {
        const step = flow.steps[i];
        lines.push(`${i + 1}. **${step.actor}**: ${step.action}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
