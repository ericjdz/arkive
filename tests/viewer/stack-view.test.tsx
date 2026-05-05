// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StackView } from "../../src/viewer/src/views/StackView.js";
import type { Decision } from "../../src/viewer/src/api/architecture.js";

const STACK = {
  language: ["TypeScript"],
  runtime: ["Node.js", "Browser"],
  framework: ["Next.js"],
  database: ["PostgreSQL"],
  infrastructure: ["Vercel", "Supabase"],
};

const DECISIONS: Decision[] = [
  {
    id: "dec-001",
    topic: "Database Choice",
    decision: "PostgreSQL over MongoDB",
    rationale: "Relational data model fits chat",
    alternatives: [{ name: "MongoDB", whyNot: "Document model" }],
    timestamp: "2026-05-05T01:00:00Z",
    relatedServices: ["database"],
  },
];

describe("StackView", () => {
  it("renders all stack categories", () => {
    render(<StackView stack={STACK} decisions={DECISIONS} />);
    expect(screen.getByText("Language")).toBeDefined();
    expect(screen.getByText("Runtime")).toBeDefined();
    expect(screen.getByText("Framework")).toBeDefined();
    expect(screen.getByText("Database")).toBeDefined();
    expect(screen.getByText("Infrastructure")).toBeDefined();
  });

  it("renders technology names", () => {
    render(<StackView stack={STACK} decisions={DECISIONS} />);
    expect(screen.getByText("TypeScript")).toBeDefined();
    expect(screen.getByText("Next.js")).toBeDefined();
    expect(screen.getByText("PostgreSQL")).toBeDefined();
  });

  it("shows 'Why this?' button for technologies with related decisions", () => {
    render(<StackView stack={STACK} decisions={DECISIONS} />);
    const buttons = screen.getAllByText(/why this/i);
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("renders empty categories gracefully", () => {
    const emptyStack = { language: [], runtime: [], framework: [], database: [], infrastructure: [] };
    render(<StackView stack={emptyStack} decisions={[]} />);
    expect(screen.getByText("Language")).toBeDefined();
  });
});
