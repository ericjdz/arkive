// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { DecisionLogView } from "../../src/viewer/src/views/DecisionLogView.js";

const DECISIONS = [
  {
    id: "dec-001",
    topic: "Database Choice",
    decision: "PostgreSQL over MongoDB",
    rationale: "Relational data model fits chat",
    alternatives: [
      { name: "MongoDB", whyNot: "Document model adds complexity" },
      { name: "Redis", whyNot: "Not suitable as primary store" },
    ],
    timestamp: "2026-05-05T01:00:00Z",
    relatedServices: ["database"],
  },
  {
    id: "dec-002",
    topic: "Real-time Strategy",
    decision: "Socket.io over Supabase Realtime",
    rationale: "More control over room management",
    alternatives: [
      { name: "Supabase Realtime", whyNot: "Tied to database changes" },
    ],
    timestamp: "2026-05-05T01:30:00Z",
    relatedServices: ["websocket-server"],
  },
];

function renderView(decisions = DECISIONS) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(React.createElement(DecisionLogView, { decisions }));
  });
  return container;
}

describe("DecisionLogView", () => {
  it("renders all decisions", () => {
    const container = renderView();
    expect(container.textContent).toContain("Database Choice");
    expect(container.textContent).toContain("Real-time Strategy");
  });

  it("shows the chosen decision", () => {
    const container = renderView();
    expect(container.textContent).toContain("PostgreSQL over MongoDB");
  });

  it("shows alternatives with reasons", () => {
    const container = renderView();
    expect(container.textContent).toContain("MongoDB");
    expect(container.textContent).toContain("Document model adds complexity");
  });

  it("shows rationale", () => {
    const container = renderView();
    expect(container.textContent).toContain("Relational data model fits chat");
  });

  it("renders empty state when no decisions", () => {
    const container = renderView([]);
    expect(container.textContent).toMatch(/no decisions/i);
  });
});
