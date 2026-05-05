// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProgressTracker } from "../../src/viewer/src/components/ProgressTracker.js";
import type { LearningProgress } from "../../src/learning/types.js";

const progressWithMastery: LearningProgress = {
  projectName: "my-chat-app",
  startedAt: "2026-05-05T00:00:00Z",
  lastActivityAt: "2026-05-05T12:00:00Z",
  concepts: [
    { conceptId: "c1", label: "DB Choice", category: "decision", mastered: true, attempts: 2, lastAttemptAt: "2026-05-05T11:00:00Z" },
    { conceptId: "c2", label: "RT Strategy", category: "decision", mastered: true, attempts: 1, lastAttemptAt: "2026-05-05T11:30:00Z" },
    { conceptId: "c3", label: "Web Client", category: "topology", mastered: false, attempts: 1, lastAttemptAt: "2026-05-05T11:45:00Z" },
    { conceptId: "c4", label: "API Server", category: "topology", mastered: false, attempts: 0, lastAttemptAt: "" },
  ],
  totalQuestions: 4,
  correctAnswers: 3,
};

const emptyProgress: LearningProgress = {
  projectName: "empty-app",
  startedAt: "2026-05-05T00:00:00Z",
  lastActivityAt: "2026-05-05T00:00:00Z",
  concepts: [],
  totalQuestions: 0,
  correctAnswers: 0,
};

describe("ProgressTracker", () => {
  it("shows mastered count out of total", () => {
    render(<ProgressTracker progress={progressWithMastery} />);
    expect(screen.getByText(/2.*\/.*4/)).toBeDefined();
  });

  it("shows accuracy percentage", () => {
    render(<ProgressTracker progress={progressWithMastery} />);
    expect(screen.getByText(/75%/)).toBeDefined();
  });

  it("renders a progress bar", () => {
    const { container } = render(<ProgressTracker progress={progressWithMastery} />);
    const bar = container.querySelector(".progress-tracker__bar-fill");
    expect(bar).not.toBeNull();
  });

  it("handles empty progress gracefully", () => {
    render(<ProgressTracker progress={emptyProgress} />);
    expect(screen.getByText(/0.*\/.*0/)).toBeDefined();
  });
});
