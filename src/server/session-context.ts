import type { Architecture } from "../schema/types.js";

export interface SessionContextOptions {
  maxTokens?: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildSessionContext(
  arch: Architecture,
  options: SessionContextOptions = {}
): string {
  const { maxTokens = 2000 } = options;
  const sections: string[] = [];

  sections.push(
    `# ${arch.project.name}`,
    arch.project.description,
    `Last updated: ${arch.project.lastUpdated}`,
    ""
  );

  const stackParts: string[] = [];
  for (const [category, items] of Object.entries(arch.stack)) {
    if (items.length > 0) stackParts.push(`${category}: ${items.join(", ")}`);
  }
  if (stackParts.length > 0) sections.push("## Stack", ...stackParts, "");

  if (arch.services.length === 0) {
    sections.push("No services documented yet.", "");
  } else {
    sections.push("## Services");
    for (const svc of arch.services) {
      let line = `- **${svc.name}** (${svc.type}) — ${svc.technology}`;
      const conf = (svc as any).confidence;
      const src = (svc as any).source;
      if (typeof conf === "number" && conf < 0.6) {
        line += ` ⚠ low confidence (${conf}, ${src ?? "unknown source"})`;
      }
      sections.push(line);
    }
    sections.push("");
  }

  if (arch.connections.length > 0) {
    sections.push("## Connections");
    for (const conn of arch.connections) {
      sections.push(`- ${conn.from} → ${conn.to} (${conn.protocol})`);
    }
    sections.push("");
  }

  let current = sections.join("\n");
  let remaining = maxTokens - estimateTokens(current);

  if (arch.decisions.length > 0 && remaining > 100) {
    const decisionLines = ["## Decisions"];
    for (const dec of arch.decisions) {
      decisionLines.push(`- ${dec.topic}: ${dec.decision}`);
      if (estimateTokens(decisionLines.join("\n")) > remaining * 0.6) break;
    }
    decisionLines.push("");
    sections.push(...decisionLines);
    current = sections.join("\n");
    remaining = maxTokens - estimateTokens(current);
  }

  if (arch.history.length > 0 && remaining > 50) {
    const recent = arch.history.slice(-5);
    const historyLines = ["## Recent Changes"];
    for (const entry of recent) {
      historyLines.push(`- ${entry.timestamp.slice(0, 10)}: ${entry.summary}`);
    }
    historyLines.push("");
    sections.push(...historyLines);
  }

  return sections.join("\n");
}
