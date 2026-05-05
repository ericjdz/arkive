import { describe, it, expect } from "vitest";
import {
  generateDecisionQuestions,
  generateTopologyQuestions,
  generateDataFlowQuestions,
  generateConnectionQuestions,
  generateAllQuestions,
} from "../../src/learning/questions.js";
import type { Architecture } from "../../src/schema/types.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";

function buildChatAppArchitecture(): Architecture {
  const arch = createEmptyArchitecture("my-chat-app", "Real-time chat application");
  arch.services = [
    {
      id: "web-client", name: "Web Client", type: "frontend",
      technology: "Next.js", description: "Server-rendered React app",
      dependencies: ["api-server", "websocket-server"],
    },
    {
      id: "api-server", name: "REST API", type: "backend",
      technology: "Next.js API Routes", description: "Handles auth, CRUD",
      dependencies: ["database"],
    },
    {
      id: "websocket-server", name: "WebSocket Server", type: "backend",
      technology: "Socket.io", description: "Real-time message delivery",
      dependencies: ["database"],
    },
    {
      id: "database", name: "PostgreSQL", type: "database",
      technology: "PostgreSQL via Supabase", description: "Persistent storage",
      dependencies: [],
    },
  ];
  arch.connections = [
    { from: "web-client", to: "api-server", protocol: "HTTP/REST", description: "Auth, channel management" },
    { from: "web-client", to: "websocket-server", protocol: "WebSocket", description: "Real-time messaging" },
    { from: "api-server", to: "database", protocol: "TCP/SQL", description: "Prisma ORM queries" },
    { from: "websocket-server", to: "database", protocol: "TCP/SQL", description: "Message persistence" },
  ];
  arch.decisions = [
    {
      id: "dec-001", topic: "Database Choice",
      decision: "PostgreSQL over MongoDB",
      rationale: "Relational data model fits chat. Strong consistency for message ordering.",
      alternatives: [
        { name: "MongoDB", whyNot: "Document model adds complexity." },
        { name: "Redis", whyNot: "Not suitable as primary store." },
      ],
      timestamp: "2026-05-05T01:00:00Z", relatedServices: ["database"],
    },
    {
      id: "dec-002", topic: "Real-time Strategy",
      decision: "Socket.io over Supabase Realtime",
      rationale: "More control over room management, typing indicators, presence.",
      alternatives: [
        { name: "Supabase Realtime", whyNot: "Tied to database changes." },
        { name: "Server-Sent Events", whyNot: "Unidirectional." },
      ],
      timestamp: "2026-05-05T01:30:00Z", relatedServices: ["websocket-server"],
    },
  ];
  arch.dataFlows = [
    {
      name: "User sends a message",
      steps: [
        { actor: "web-client", action: "User types message, hits send" },
        { actor: "web-client", action: "Emits 'send_message' via WebSocket" },
        { actor: "websocket-server", action: "Receives message, validates, persists to DB" },
        { actor: "database", action: "INSERT into messages table" },
        { actor: "websocket-server", action: "Broadcasts 'new_message' to all room members" },
        { actor: "web-client", action: "Receives broadcast, appends to chat UI" },
      ],
    },
  ];
  return arch;
}

describe("generateDecisionQuestions", () => {
  it("generates one multiple-choice question per decision", () => {
    const arch = buildChatAppArchitecture();
    const questions = generateDecisionQuestions(arch);
    expect(questions).toHaveLength(2);
    expect(questions[0].type).toBe("multiple-choice");
  });

  it("includes the correct rationale as the right answer", () => {
    const arch = buildChatAppArchitecture();
    const questions = generateDecisionQuestions(arch);
    const q = questions[0];
    expect(q.type).toBe("multiple-choice");
    if (q.type === "multiple-choice") {
      const correctChoice = q.choices.find((c) => c.correct);
      expect(correctChoice).toBeDefined();
      expect(correctChoice!.text).toContain("Relational");
    }
  });

  it("includes rejected alternatives as wrong answers", () => {
    const arch = buildChatAppArchitecture();
    const questions = generateDecisionQuestions(arch);
    if (questions[0].type === "multiple-choice") {
      const wrongChoices = questions[0].choices.filter((c) => !c.correct);
      expect(wrongChoices.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("links back to the source decision", () => {
    const arch = buildChatAppArchitecture();
    const questions = generateDecisionQuestions(arch);
    expect(questions[0].sourceRef).toEqual({ type: "decision", id: "dec-001" });
  });
});

describe("generateTopologyQuestions", () => {
  it("generates questions about service dependencies", () => {
    const arch = buildChatAppArchitecture();
    const questions = generateTopologyQuestions(arch);
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.every((q) => q.category === "topology")).toBe(true);
  });

  it("asks about dependencies for services that have them", () => {
    const arch = buildChatAppArchitecture();
    const questions = generateTopologyQuestions(arch);
    const dbQ = questions.find((q) => q.question.includes("PostgreSQL"));
    expect(dbQ).toBeDefined();
  });
});

describe("generateConnectionQuestions", () => {
  it("generates questions about connection protocols", () => {
    const arch = buildChatAppArchitecture();
    const questions = generateConnectionQuestions(arch);
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.every((q) => q.category === "connection")).toBe(true);
  });

  it("asks what protocol a connection uses", () => {
    const arch = buildChatAppArchitecture();
    const questions = generateConnectionQuestions(arch);
    const wsQ = questions.find((q) => q.question.includes("web-client") && q.question.includes("websocket-server"));
    expect(wsQ).toBeDefined();
  });
});

describe("generateDataFlowQuestions", () => {
  it("generates ordering questions for data flows", () => {
    const arch = buildChatAppArchitecture();
    const questions = generateDataFlowQuestions(arch);
    expect(questions).toHaveLength(1);
    expect(questions[0].type).toBe("ordering");
  });

  it("includes all steps in the correct order", () => {
    const arch = buildChatAppArchitecture();
    const questions = generateDataFlowQuestions(arch);
    const q = questions[0];
    if (q.type === "ordering") {
      expect(q.items).toHaveLength(6);
      expect(q.correctOrder).toHaveLength(6);
    }
  });
});

describe("generateAllQuestions", () => {
  it("combines all question types", () => {
    const arch = buildChatAppArchitecture();
    const questions = generateAllQuestions(arch);
    const types = new Set(questions.map((q) => q.category));
    expect(types.has("decision")).toBe(true);
    expect(types.has("topology")).toBe(true);
    expect(types.has("connection")).toBe(true);
    expect(types.has("data-flow")).toBe(true);
  });

  it("returns empty array for empty architecture", () => {
    const arch = createEmptyArchitecture("empty", "Nothing");
    const questions = generateAllQuestions(arch);
    expect(questions).toHaveLength(0);
  });

  it("assigns unique IDs to all questions", () => {
    const arch = buildChatAppArchitecture();
    const questions = generateAllQuestions(arch);
    const ids = questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
