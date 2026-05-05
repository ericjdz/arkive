import { useState } from "react";
import type { Service } from "../api/architecture.js";

interface TreeViewProps {
  services: Service[];
}

export function TreeView({ services }: TreeViewProps) {
  if (services.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--color-text-muted)" }}>
        No services defined yet.
      </div>
    );
  }

  const grouped = new Map<string, Service[]>();
  for (const s of services) {
    const list = grouped.get(s.type) ?? [];
    list.push(s);
    grouped.set(s.type, list);
  }

  return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: "2rem 1rem", height: "100%", overflowY: "auto" }}>
      <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "1.5rem" }}>
        Component Tree ({services.length} services)
      </h2>
      {Array.from(grouped.entries()).map(([type, items]) => (
        <TreeGroup key={type} type={type} services={items} />
      ))}
    </div>
  );
}

function TreeGroup({ type, services }: { type: string; services: Service[] }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          width: "100%",
          padding: "0.5rem 0.75rem",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius)",
          color: "var(--color-text)",
          fontSize: "0.875rem",
          fontWeight: 600,
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: "0.75rem", width: 16, textAlign: "center" }}>
          {expanded ? "▼" : "▶"}
        </span>
        <span>{type}</span>
        <span style={{ marginLeft: "auto", fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
          {services.length}
        </span>
      </button>
      {expanded && (
        <div style={{ borderLeft: "2px solid var(--color-border)", marginLeft: "1.25rem", paddingLeft: "1rem", marginTop: "0.25rem" }}>
          {services.map((s) => (
            <div key={s.id} style={{ padding: "0.5rem 0.75rem", marginBottom: 2, borderRadius: "calc(var(--radius) - 2px)", fontSize: "0.8125rem" }}>
              <div style={{ fontWeight: 500 }}>{s.name}</div>
              <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", fontFamily: "var(--font-mono)" }}>{s.technology}</div>
              {s.dependencies.length > 0 && (
                <div style={{ fontSize: "0.6875rem", color: "var(--color-text-muted)", marginTop: 2 }}>
                  → {s.dependencies.join(", ")}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
