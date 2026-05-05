import { useState } from "react";
import type { DataFlow, Service } from "../api/architecture.js";

interface DataFlowViewProps {
  dataFlows: DataFlow[];
  services: Service[];
}

export function DataFlowView({ dataFlows, services }: DataFlowViewProps) {
  const [selectedFlow, setSelectedFlow] = useState<number>(0);
  const [activeStep, setActiveStep] = useState<number>(-1);

  if (dataFlows.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--color-text-muted)" }}>
        No data flows defined yet.
      </div>
    );
  }

  const flow = dataFlows[selectedFlow];
  const nameMap = new Map(services.map((s) => [s.id, s.name]));

  const actors: string[] = [];
  const seen = new Set<string>();
  for (const step of flow.steps) {
    if (!seen.has(step.actor)) {
      seen.add(step.actor);
      actors.push(step.actor);
    }
  }

  function playAnimation() {
    setActiveStep(0);
    let step = 0;
    const interval = setInterval(() => {
      step++;
      if (step >= flow.steps.length) {
        clearInterval(interval);
        return;
      }
      setActiveStep(step);
    }, 1200);
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "2rem 1rem", height: "100%", overflowY: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "1.25rem", fontWeight: 600 }}>Data Flows ({dataFlows.length})</h2>
        <button onClick={playAnimation} style={{ padding: "0.5rem 1rem", background: "var(--color-accent)", color: "#fff", border: "none", borderRadius: "var(--radius)", fontSize: "0.8125rem", fontWeight: 500 }}>
          ▶ Play
        </button>
      </div>

      {dataFlows.length > 1 && (
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
          {dataFlows.map((f, i) => (
            <button key={i} onClick={() => { setSelectedFlow(i); setActiveStep(-1); }} style={{ padding: "0.375rem 0.75rem", background: i === selectedFlow ? "var(--color-accent)" : "var(--color-surface)", color: i === selectedFlow ? "#fff" : "var(--color-text)", border: "1px solid var(--color-border)", borderRadius: "var(--radius)", fontSize: "0.8125rem" }}>
              {f.name}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 0, marginBottom: "1rem" }}>
        {actors.map((actor) => (
          <div key={actor} style={{ flex: 1, textAlign: "center", padding: "0.75rem", background: "var(--color-surface)", border: "1px solid var(--color-border)", fontWeight: 600, fontSize: "0.8125rem" }}>
            {nameMap.get(actor) ?? actor}
          </div>
        ))}
      </div>

      {flow.steps.map((step, i) => {
        const colIndex = actors.indexOf(step.actor);
        const isActive = i <= activeStep;

        return (
          <div key={i} style={{ display: "flex", gap: 0, minHeight: 60 }}>
            {actors.map((actor, ai) => (
              <div key={ai} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", borderLeft: ai === 0 ? "1px solid var(--color-border)" : "none", borderRight: "1px solid var(--color-border)", borderBottom: "1px solid var(--color-border)", padding: "0.5rem" }}>
                {ai === colIndex && (
                  <div style={{ padding: "0.5rem 0.75rem", background: isActive ? "var(--color-accent)" : "var(--color-surface)", color: isActive ? "#fff" : "var(--color-text)", borderRadius: "var(--radius)", fontSize: "0.75rem", textAlign: "center", transition: "all 0.3s ease", opacity: isActive || activeStep === -1 ? 1 : 0.3 }}>
                    <div style={{ fontWeight: 500 }}>{i + 1}. {step.action}</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
