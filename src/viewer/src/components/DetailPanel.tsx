import type { Service, Decision, Connection } from "../api/architecture.js";
import { PromptInput } from "./PromptInput.js";

interface DetailPanelProps {
  service: Service | null;
  connections: Connection[];
  decisions: Decision[];
  onClose: () => void;
  onAddPrompt?: (serviceId: string, prompt: string) => void;
}

export function DetailPanel({
  service,
  connections,
  decisions,
  onClose,
  onAddPrompt,
}: DetailPanelProps) {
  if (!service) return null;

  const inbound = connections.filter((c) => c.to === service.id);
  const outbound = connections.filter((c) => c.from === service.id);
  const relatedDecisions = decisions.filter((d) =>
    d.relatedServices.includes(service.id)
  );

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        width: 380,
        height: "100%",
        background: "var(--color-surface)",
        borderLeft: "1px solid var(--color-border)",
        padding: "1.5rem",
        overflowY: "auto",
        zIndex: 100,
        boxShadow: "-4px 0 24px rgba(0,0,0,0.4)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "1.5rem",
        }}
      >
        <h2 style={{ fontSize: "1.125rem", fontWeight: 600 }}>
          {service.name}
        </h2>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--color-text-muted)",
            fontSize: "1.25rem",
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <div style={{ fontSize: "0.75rem", textTransform: "uppercase", color: "var(--color-text-muted)", marginBottom: 4 }}>Type</div>
        <div>{service.type}</div>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <div style={{ fontSize: "0.75rem", textTransform: "uppercase", color: "var(--color-text-muted)", marginBottom: 4 }}>Technology</div>
        <div style={{ fontFamily: "var(--font-mono)" }}>{service.technology}</div>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <div style={{ fontSize: "0.75rem", textTransform: "uppercase", color: "var(--color-text-muted)", marginBottom: 4 }}>Description</div>
        <div>{service.description}</div>
      </div>

      {service.ports && service.ports.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <div style={{ fontSize: "0.75rem", textTransform: "uppercase", color: "var(--color-text-muted)", marginBottom: 4 }}>Ports</div>
          <div style={{ fontFamily: "var(--font-mono)" }}>{service.ports.join(", ")}</div>
        </div>
      )}

      {inbound.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <div style={{ fontSize: "0.75rem", textTransform: "uppercase", color: "var(--color-text-muted)", marginBottom: 8 }}>Inbound Connections</div>
          {inbound.map((c, i) => (
            <div key={i} style={{ padding: "0.5rem", background: "var(--color-bg)", borderRadius: "var(--radius)", marginBottom: 4, fontSize: "0.8125rem" }}>
              <strong>{c.from}</strong> → {c.protocol}
              <div style={{ color: "var(--color-text-muted)", fontSize: "0.75rem" }}>{c.description}</div>
            </div>
          ))}
        </div>
      )}

      {outbound.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <div style={{ fontSize: "0.75rem", textTransform: "uppercase", color: "var(--color-text-muted)", marginBottom: 8 }}>Outbound Connections</div>
          {outbound.map((c, i) => (
            <div key={i} style={{ padding: "0.5rem", background: "var(--color-bg)", borderRadius: "var(--radius)", marginBottom: 4, fontSize: "0.8125rem" }}>
              → <strong>{c.to}</strong> via {c.protocol}
              <div style={{ color: "var(--color-text-muted)", fontSize: "0.75rem" }}>{c.description}</div>
            </div>
          ))}
        </div>
      )}

      {relatedDecisions.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <div style={{ fontSize: "0.75rem", textTransform: "uppercase", color: "var(--color-text-muted)", marginBottom: 8 }}>Related Decisions</div>
          {relatedDecisions.map((d) => (
            <div key={d.id} style={{ padding: "0.75rem", background: "var(--color-bg)", borderRadius: "var(--radius)", marginBottom: 8, borderLeft: "3px solid var(--color-accent)" }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{d.topic}</div>
              <div style={{ fontSize: "0.8125rem", marginBottom: 4 }}>{d.decision}</div>
              <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>{d.rationale}</div>
            </div>
          ))}
        </div>
      )}

      {onAddPrompt && (
        <PromptInput
          serviceId={service.id}
          serviceName={service.name}
          onSubmit={(prompt) => onAddPrompt(service.id, prompt)}
        />
      )}
    </div>
  );
}
