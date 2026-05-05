import type { Decision } from "../api/architecture.js";
import { DecisionCard } from "../components/DecisionCard.js";

interface DecisionLogViewProps {
  decisions: Decision[];
}

export function DecisionLogView({ decisions }: DecisionLogViewProps) {
  if (decisions.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--color-text-muted)" }}>
        No decisions recorded yet.
      </div>
    );
  }

  const sorted = [...decisions].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem", height: "100%", overflowY: "auto" }}>
      <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "1.5rem" }}>
        Architectural Decisions ({decisions.length})
      </h2>
      <div style={{ borderLeft: "2px solid var(--color-border)", paddingLeft: "1.5rem" }}>
        {sorted.map((d) => (
          <DecisionCard key={d.id} decision={d} />
        ))}
      </div>
    </div>
  );
}
