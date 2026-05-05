export type ViewId = "topology" | "dataflow" | "decisions" | "tree" | "stack" | "learning";

interface ViewSwitcherProps {
  activeView: ViewId;
  onViewChange: (view: ViewId) => void;
}

const VIEWS: { id: ViewId; label: string; icon: string }[] = [
  { id: "topology", label: "Topology", icon: "🔗" },
  { id: "dataflow", label: "Data Flow", icon: "➡️" },
  { id: "decisions", label: "Decisions", icon: "⚖️" },
  { id: "tree", label: "Tree", icon: "🌳" },
  { id: "stack", label: "Stack", icon: "📦" },
  { id: "learning", label: "Learning", icon: "🧠" },
];

export function ViewSwitcher({ activeView, onViewChange }: ViewSwitcherProps) {
  return (
    <nav
      style={{
        display: "flex",
        gap: "0.25rem",
        padding: "0.25rem",
        background: "var(--color-surface)",
        borderRadius: "var(--radius)",
        border: "1px solid var(--color-border)",
      }}
    >
      {VIEWS.map((view) => (
        <button
          key={view.id}
          onClick={() => onViewChange(view.id)}
          style={{
            padding: "0.5rem 1rem",
            borderRadius: "calc(var(--radius) - 2px)",
            border: "none",
            background:
              activeView === view.id
                ? "var(--color-accent)"
                : "transparent",
            color:
              activeView === view.id
                ? "#fff"
                : "var(--color-text-muted)",
            fontSize: "0.8125rem",
            fontWeight: activeView === view.id ? 600 : 400,
            transition: "all 0.15s ease",
          }}
        >
          {view.icon} {view.label}
        </button>
      ))}
    </nav>
  );
}
