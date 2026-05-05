// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuestionCard } from "../../src/viewer/src/components/QuestionCard.js";
import type { MultipleChoiceQuestion, OrderingQuestion } from "../../src/learning/types.js";

const mcQuestion: MultipleChoiceQuestion = {
  id: "q-001",
  type: "multiple-choice",
  category: "decision",
  conceptId: "concept-dec-001",
  question: 'Why did this project choose "PostgreSQL over MongoDB"?',
  choices: [
    { id: "a", text: "Relational data model fits chat domain", correct: true },
    { id: "b", text: "PostgreSQL is faster", correct: false },
    { id: "c", text: "MongoDB is not free", correct: false },
  ],
  explanation: "Relational data model fits chat.",
  sourceRef: { type: "decision", id: "dec-001" },
};

const orderingQuestion: OrderingQuestion = {
  id: "q-002",
  type: "ordering",
  category: "data-flow",
  conceptId: "concept-flow-send",
  question: "Arrange the steps for sending a message:",
  items: [
    { id: "s1", text: "User types message" },
    { id: "s2", text: "Emit via WebSocket" },
    { id: "s3", text: "Server persists to DB" },
  ],
  correctOrder: ["s1", "s2", "s3"],
  explanation: "Message flows from client to server to DB.",
  sourceRef: { type: "dataFlow", name: "User sends a message" },
};

describe("QuestionCard", () => {
  it("renders the question text", () => {
    render(<QuestionCard question={mcQuestion} onAnswer={vi.fn()} />);
    expect(screen.getByText(/PostgreSQL over MongoDB/)).toBeDefined();
  });

  it("renders all choices for multiple-choice", () => {
    render(<QuestionCard question={mcQuestion} onAnswer={vi.fn()} />);
    expect(screen.getByText("Relational data model fits chat domain")).toBeDefined();
    expect(screen.getByText("PostgreSQL is faster")).toBeDefined();
    expect(screen.getByText("MongoDB is not free")).toBeDefined();
  });

  it("calls onAnswer with true when correct choice selected", () => {
    const onAnswer = vi.fn();
    render(<QuestionCard question={mcQuestion} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText("Relational data model fits chat domain"));
    fireEvent.click(screen.getByText("Submit"));
    expect(onAnswer).toHaveBeenCalledWith(true);
  });

  it("calls onAnswer with false when wrong choice selected", () => {
    const onAnswer = vi.fn();
    render(<QuestionCard question={mcQuestion} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText("PostgreSQL is faster"));
    fireEvent.click(screen.getByText("Submit"));
    expect(onAnswer).toHaveBeenCalledWith(false);
  });

  it("shows explanation after answering", () => {
    render(<QuestionCard question={mcQuestion} onAnswer={vi.fn()} />);
    fireEvent.click(screen.getByText("Relational data model fits chat domain"));
    fireEvent.click(screen.getByText("Submit"));
    expect(screen.getByText(/Relational data model fits chat/)).toBeDefined();
  });

  it("renders ordering question items", () => {
    render(<QuestionCard question={orderingQuestion} onAnswer={vi.fn()} />);
    expect(screen.getByText("User types message")).toBeDefined();
    expect(screen.getByText("Emit via WebSocket")).toBeDefined();
    expect(screen.getByText("Server persists to DB")).toBeDefined();
  });
});
