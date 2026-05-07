// src/viewer/src/components/PromptQueuePanel.tsx
import type { QueuedPrompt } from "../api/prompts.js";

interface PromptQueuePanelProps {
  prompts: QueuedPrompt[];
  isOpen: boolean;
  onToggle: () => void;
  onRemove: (id: string) => void;
  onCopyAll: () => void;
}

export function PromptQueuePanel({
  prompts,
  isOpen,
  onToggle,
  onRemove,
  onCopyAll,
}: PromptQueuePanelProps) {
  const pendingCount = prompts.filter((p) => p.status === "pending").length;

  return (
    <>
      {/* Floating badge button */}
      <button
        data-testid="queue-toggle"
        onClick={onToggle}
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          width: 48,
          height: 48,
          borderRadius: "50%",
          background: pendingCount > 0 ? "var(--color-accent)" : "var(--color-surface)",
          color: pendingCount > 0 ? "#fff" : "var(--color-text-muted)",
          border: "2px solid var(--color-border)",
          fontSize: "1.125rem",
          fontWeight: 700,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          zIndex: 200,
        }}
      >
        {pendingCount || "Q"}
      </button>

      {/* Slide-out panel */}
      {isOpen && (
        <div
          style={{
            position: "fixed",
            bottom: 80,
            right: 24,
            width: 360,
            maxHeight: "60vh",
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
            zIndex: 200,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "0.75rem 1rem",
              borderBottom: "1px solid var(--color-border)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>
              Prompt Queue — {pendingCount} prompt{pendingCount !== 1 ? "s" : ""}
            </div>
            <button
              onClick={onCopyAll}
              disabled={pendingCount === 0}
              style={{
                padding: "0.25rem 0.75rem",
                background: pendingCount > 0 ? "var(--color-accent)" : "var(--color-border)",
                color: "#fff",
                border: "none",
                borderRadius: "var(--radius)",
                fontSize: "0.75rem",
                fontWeight: 600,
                cursor: pendingCount > 0 ? "pointer" : "not-allowed",
              }}
            >
              Copy All
            </button>
          </div>

          {/* Prompt list */}
          <div style={{ overflowY: "auto", flex: 1, padding: "0.5rem" }}>
            {prompts.length === 0 && (
              <div
                style={{
                  padding: "2rem 1rem",
                  textAlign: "center",
                  color: "var(--color-text-muted)",
                  fontSize: "0.8125rem",
                }}
              >
                No prompts queued. Select a node and write a prompt.
              </div>
            )}
            {prompts.map((p) => (
              <div
                key={p.id}
                style={{
                  padding: "0.75rem",
                  background: "var(--color-bg)",
                  borderRadius: "var(--radius)",
                  marginBottom: 6,
                  borderLeft: `3px solid ${p.status === "pending" ? "var(--color-accent)" : "var(--color-text-muted)"}`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    marginBottom: 4,
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.6875rem",
                      color: "var(--color-text-muted)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {p.targetServices.length > 0 ? p.targetServices.join(", ") : "global"}
                  </div>
                  <button
                    data-testid={`remove-${p.id}`}
                    onClick={() => onRemove(p.id)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--color-text-muted)",
                      cursor: "pointer",
                      fontSize: "0.875rem",
                      lineHeight: 1,
                      padding: 0,
                    }}
                  >
                    ✕
                  </button>
                </div>
                <div style={{ fontSize: "0.8125rem" }}>{p.prompt}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
