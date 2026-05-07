// src/viewer/src/components/PromptInput.tsx
import { useState } from "../../node_modules/react/index.js";

interface PromptInputProps {
  serviceId: string;
  serviceName: string;
  onSubmit: (prompt: string) => void;
}

export function PromptInput({ serviceId, serviceName, onSubmit }: PromptInputProps) {
  const [text, setText] = useState("");

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      handleSubmit();
    }
  };

  return (
    <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--color-border)" }}>
      <div
        style={{
          fontSize: "0.75rem",
          textTransform: "uppercase",
          color: "var(--color-text-muted)",
          marginBottom: 8,
        }}
      >
        Add prompt for {serviceName}
      </div>
      <textarea
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={handleKeyDown}
        placeholder={`Describe a change for ${serviceName}...`}
        style={{
          width: "100%",
          minHeight: 80,
          padding: "0.5rem",
          background: "var(--color-bg)",
          color: "var(--color-text)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius)",
          fontFamily: "inherit",
          fontSize: "0.8125rem",
          resize: "vertical",
        }}
      />
      <button
        data-testid="submit-prompt"
        onClick={handleSubmit}
        disabled={!text.trim()}
        style={{
          marginTop: 8,
          width: "100%",
          padding: "0.5rem",
          background: text.trim() ? "var(--color-accent)" : "var(--color-border)",
          color: "#fff",
          border: "none",
          borderRadius: "var(--radius)",
          cursor: text.trim() ? "pointer" : "not-allowed",
          fontSize: "0.8125rem",
          fontWeight: 600,
        }}
      >
        + Queue Prompt
      </button>
      <div style={{ fontSize: "0.6875rem", color: "var(--color-text-muted)", marginTop: 4 }}>
        Ctrl+Enter to submit
      </div>
    </div>
  );
}
