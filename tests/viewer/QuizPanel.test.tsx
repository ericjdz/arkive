// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuizPanel } from "../../src/viewer/src/components/QuizPanel.js";
import type { Question, MultipleChoiceQuestion } from "../../src/learning/types.js";

const questions: MultipleChoiceQuestion[] = [
  {
    id: "q-001",
    type: "multiple-choice",
    category: "decision",
    conceptId: "concept-dec-001",
    question: "Why PostgreSQL?",
    choices: [
      { id: "a", text: "Relational model fits", correct: true },
      { id: "b", text: "It is faster", correct: false },
    ],
    explanation: "Relational model.",
    sourceRef: { type: "decision", id: "dec-001" },
  },
  {
    id: "q-002",
    type: "multiple-choice",
    category: "decision",
    conceptId: "concept-dec-002",
    question: "Why Socket.io?",
    choices: [
      { id: "a", text: "More control", correct: true },
      { id: "b", text: "Only option", correct: false },
    ],
    explanation: "More control over rooms.",
    sourceRef: { type: "decision", id: "dec-002" },
  },
];

describe("QuizPanel", () => {
  it("renders the current question", () => {
    render(
      <QuizPanel
        questions={questions}
        currentQuestion={questions[0]}
        onAnswer={vi.fn()}
        onNext={vi.fn()}
        questionNumber={1}
        totalQuestions={2}
      />
    );
    expect(screen.getByText("Why PostgreSQL?")).toBeDefined();
  });

  it("shows question number", () => {
    render(
      <QuizPanel
        questions={questions}
        currentQuestion={questions[0]}
        onAnswer={vi.fn()}
        onNext={vi.fn()}
        questionNumber={1}
        totalQuestions={2}
      />
    );
    expect(screen.getByText(/1.*of.*2/i)).toBeDefined();
  });

  it("shows completion message when no current question", () => {
    render(
      <QuizPanel
        questions={questions}
        currentQuestion={null}
        onAnswer={vi.fn()}
        onNext={vi.fn()}
        questionNumber={3}
        totalQuestions={2}
      />
    );
    expect(screen.getByText(/all concepts/i)).toBeDefined();
  });

  it("shows Next button after answering", () => {
    render(
      <QuizPanel
        questions={questions}
        currentQuestion={questions[0]}
        onAnswer={vi.fn()}
        onNext={vi.fn()}
        questionNumber={1}
        totalQuestions={2}
      />
    );
    // Select and submit an answer
    fireEvent.click(screen.getByText("Relational model fits"));
    fireEvent.click(screen.getByText("Submit"));
    expect(screen.getByText("Next")).toBeDefined();
  });
});
