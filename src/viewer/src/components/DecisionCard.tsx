import type { Decision } from "../api/architecture.js";

interface DecisionCardProps {
  decision: Decision;
}

export function DecisionCard({ decision }: DecisionCardProps) {
  const date = new Date(decision.timestamp).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <div
      style={{
        background: "var(--color-surface)",
        borderRadius: "var(--radius)",
        border: "1px solid var(--color-border)",
        padding: "1.25rem",
        marginBottom: "1rem",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.75rem" }}>
        <h3 style={{ fontSize: "1rem", fontWeight: 600 }}>{decision.topic}</h3>
        <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>{date}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem", padding: "0.5rem 0.75rem", background: "var(--color-accent)", borderRadius: "calc(var(--radius) - 2px)", color: "#fff", fontSize: "0.875rem", fontWeight: 500 }}>
        ✓ {decision.decision}
      </div>
      <div style={{ fontSize: "0.8125rem", color: "var(--color-text-muted)", marginBottom: "1rem", lineHeight: 1.6 }}>
        {decision.rationale}
      </div>
      {decision.alternatives.length > 0 && (
        <div>
          <div style={{ fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-muted)", marginBottom: "0.5rem" }}>Alternatives considered</div>
          {decision.alternatives.map((alt, i) => (
            <div key={i} style={{ display: "flex", gap: "0.75rem", padding: "0.5rem 0.75rem", background: "var(--color-bg)", borderRadius: "calc(var(--radius) - 2px)", marginBottom: 4, fontSize: "0.8125rem", borderLeft: "3px solid var(--color-error)" }}>
              <span style={{ fontWeight: 500, flexShrink: 0 }}>{alt.name}</span>
              <span style={{ color: "var(--color-text-muted)" }}>{alt.whyNot}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
