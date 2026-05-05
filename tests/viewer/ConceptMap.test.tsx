// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConceptMap } from "../../src/viewer/src/components/ConceptMap.js";
import type { ConceptMastery } from "../../src/learning/types.js";

const concepts: ConceptMastery[] = [
  { conceptId: "c1", label: "DB Choice", category: "decision", mastered: true, attempts: 2, lastAttemptAt: "2026-05-05T11:00:00Z" },
  { conceptId: "c2", label: "RT Strategy", category: "decision", mastered: false, attempts: 1, lastAttemptAt: "2026-05-05T11:30:00Z" },
  { conceptId: "c3", label: "Web Client", category: "topology", mastered: false, attempts: 0, lastAttemptAt: "" },
  { conceptId: "c4", label: "WS → DB", category: "connection", mastered: true, attempts: 1, lastAttemptAt: "2026-05-05T12:00:00Z" },
];

describe("ConceptMap", () => {
  it("renders all concept labels", () => {
    render(<ConceptMap concepts={concepts} />);
    expect(screen.getByText("DB Choice")).toBeDefined();
    expect(screen.getByText("RT Strategy")).toBeDefined();
    expect(screen.getByText("Web Client")).toBeDefined();
    expect(screen.getByText("WS → DB")).toBeDefined();
  });

  it("groups concepts by category", () => {
    const { container } = render(<ConceptMap concepts={concepts} />);
    const groups = container.querySelectorAll(".concept-map__group");
    expect(groups.length).toBeGreaterThanOrEqual(3);
  });

  it("marks mastered concepts", () => {
    const { container } = render(<ConceptMap concepts={concepts} />);
    const mastered = container.querySelectorAll(".concept-map__node--mastered");
    expect(mastered).toHaveLength(2);
  });

  it("marks attempted but unmastered concepts", () => {
    const { container } = render(<ConceptMap concepts={concepts} />);
    const attempted = container.querySelectorAll(".concept-map__node--attempted");
    expect(attempted).toHaveLength(1);
  });

  it("marks unexplored concepts", () => {
    const { container } = render(<ConceptMap concepts={concepts} />);
    const unexplored = container.querySelectorAll(".concept-map__node--unexplored");
    expect(unexplored).toHaveLength(1);
  });

  it("handles empty concepts array", () => {
    const { container } = render(<ConceptMap concepts={[]} />);
    expect(container.querySelector(".concept-map__empty")).not.toBeNull();
  });
});
