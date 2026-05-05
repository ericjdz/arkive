import { createElement } from "../../../../node_modules/react/index.js";
import type { Decision } from "../api/architecture.js";

interface Stack {
  language: string[];
  runtime: string[];
  framework: string[];
  database: string[];
  infrastructure: string[];
}

interface StackViewProps {
  stack: Stack;
  decisions: Decision[];
}

const CATEGORY_LABELS: { key: keyof Stack; label: string; color: string }[] = [
  { key: "language", label: "Language", color: "var(--color-frontend)" },
  { key: "runtime", label: "Runtime", color: "var(--color-success)" },
  { key: "framework", label: "Framework", color: "var(--color-accent)" },
  { key: "database", label: "Database", color: "var(--color-database)" },
  { key: "infrastructure", label: "Infrastructure", color: "var(--color-backend)" },
];

export function StackView({ stack, decisions }: StackViewProps) {
  function findDecision(tech: string): Decision | undefined {
    const techLower = tech.toLowerCase();
    return decisions.find(
      (d) =>
        d.decision.toLowerCase().includes(techLower) ||
        d.topic.toLowerCase().includes(techLower)
    );
  }

  return createElement(
    "div",
    { style: { maxWidth: 800, margin: "0 auto", padding: "2rem 1rem", height: "100%", overflowY: "auto" } },
    createElement("h2", { style: { fontSize: "1.25rem", fontWeight: 600, marginBottom: "1.5rem" } }, "Technology Stack"),
    createElement(
      "div",
      { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "1rem" } },
      CATEGORY_LABELS.map(({ key, label, color }) =>
        createElement(
          "div",
          { key, style: { background: "var(--color-surface)", borderRadius: "var(--radius)", border: "1px solid var(--color-border)", padding: "1.25rem" } },
          createElement("div", { style: { fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.05em", color, marginBottom: "0.75rem", fontWeight: 600 } }, label),
          stack[key].length === 0
            ? createElement("div", { style: { fontSize: "0.8125rem", color: "var(--color-text-muted)", fontStyle: "italic" } }, "None specified")
            : createElement(
                "div",
                { style: { display: "flex", flexWrap: "wrap", gap: "0.5rem" } },
                stack[key].map((tech) => {
                  const related = findDecision(tech);
                  return createElement(
                    "div",
                    { key: tech },
                    createElement(
                      "div",
                      { style: { display: "inline-flex", alignItems: "center", gap: "0.5rem", padding: "0.375rem 0.75rem", background: "var(--color-bg)", borderRadius: "calc(var(--radius) - 2px)", fontSize: "0.8125rem", fontWeight: 500 } },
                      tech,
                      related
                        ? createElement("button", { style: { background: "none", border: "none", color: "var(--color-accent)", fontSize: "0.6875rem", padding: 0, textDecoration: "underline" } }, "Why this?")
                        : null
                    ),
                    related
                      ? createElement(
                          "div",
                          { style: { marginTop: "0.5rem", padding: "0.75rem", background: "var(--color-bg)", borderRadius: "calc(var(--radius) - 2px)", borderLeft: "3px solid var(--color-accent)", fontSize: "0.8125rem" } },
                          createElement("div", { style: { fontWeight: 500, marginBottom: 4 } }, related.decision),
                          createElement("div", { style: { color: "var(--color-text-muted)", fontSize: "0.75rem" } }, related.rationale)
                        )
                      : null
                  );
                })
              )
        )
      )
    )
  );
}
