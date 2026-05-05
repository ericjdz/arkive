import { describe, it, expect } from "vitest";
import {
  isMultipleChoiceQuestion,
  isShortAnswerQuestion,
  isOrderingQuestion,
  type Question,
  type MultipleChoiceQuestion,
  type ShortAnswerQuestion,
  type OrderingQuestion,
  type LearningProgress,
  type ConceptMastery,
} from "../../src/learning/types.js";

describe("Learning Types", () => {
  describe("type guards", () => {
    it("identifies a multiple-choice question", () => {
      const q: MultipleChoiceQuestion = {
        id: "q-001",
        type: "multiple-choice",
        category: "decision",
        conceptId: "concept-db-choice",
        question: "Why did this project choose PostgreSQL over MongoDB?",
        choices: [
          { id: "a", text: "Relational data model fits chat domain", correct: true },
          { id: "b", text: "PostgreSQL is faster than MongoDB", correct: false },
          { id: "c", text: "MongoDB doesn't support JavaScript", correct: false },
          { id: "d", text: "PostgreSQL is free and MongoDB is not", correct: false },
        ],
        explanation: "The relational data model fits chat (users, channels, messages with foreign keys).",
        sourceRef: { type: "decision", id: "dec-001" },
      };
      expect(isMultipleChoiceQuestion(q)).toBe(true);
      expect(isShortAnswerQuestion(q)).toBe(false);
    });

    it("identifies a short-answer question", () => {
      const q: ShortAnswerQuestion = {
        id: "q-002",
        type: "short-answer",
        category: "topology",
        conceptId: "concept-ws-deps",
        question: "Which services depend on the WebSocket Server?",
        acceptableAnswers: ["web-client", "Web Client"],
        explanation: "The web-client connects to the WebSocket server for real-time messaging.",
        sourceRef: { type: "service", id: "websocket-server" },
      };
      expect(isShortAnswerQuestion(q)).toBe(true);
      expect(isMultipleChoiceQuestion(q)).toBe(false);
    });

    it("identifies an ordering question", () => {
      const q: OrderingQuestion = {
        id: "q-003",
        type: "ordering",
        category: "data-flow",
        conceptId: "concept-send-message-flow",
        question: "Arrange the steps for 'User sends a message':",
        items: [
          { id: "s1", text: "User types message, hits send" },
          { id: "s2", text: "Emits 'send_message' via WebSocket" },
          { id: "s3", text: "Server receives, validates, persists to DB" },
          { id: "s4", text: "INSERT into messages table" },
          { id: "s5", text: "Broadcasts 'new_message' to room members" },
          { id: "s6", text: "Client receives broadcast, appends to UI" },
        ],
        correctOrder: ["s1", "s2", "s3", "s4", "s5", "s6"],
        explanation: "The message flows from client through WebSocket to DB and back.",
        sourceRef: { type: "dataFlow", name: "User sends a message" },
      };
      expect(isOrderingQuestion(q)).toBe(true);
      expect(isMultipleChoiceQuestion(q)).toBe(false);
    });
  });

  describe("LearningProgress structure", () => {
    it("has the expected shape", () => {
      const progress: LearningProgress = {
        projectName: "my-chat-app",
        startedAt: "2026-05-05T00:00:00Z",
        lastActivityAt: "2026-05-05T12:00:00Z",
        concepts: [
          {
            conceptId: "concept-db-choice",
            label: "Database Choice",
            category: "decision",
            mastered: true,
            attempts: 2,
            lastAttemptAt: "2026-05-05T11:00:00Z",
          },
        ],
        totalQuestions: 5,
        correctAnswers: 3,
      };
      expect(progress.concepts).toHaveLength(1);
      expect(progress.concepts[0].mastered).toBe(true);
    });
  });
});
