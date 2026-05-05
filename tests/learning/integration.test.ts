import { describe, it, expect } from "vitest";
import { createEmptyArchitecture } from "../../src/schema/validate.js";
import { extractConcepts } from "../../src/learning/concepts.js";
import { generateAllQuestions } from "../../src/learning/questions.js";
import { createInitialProgress, recordAnswer, mergeNewConcepts } from "../../src/learning/progress.js";
import type { Architecture } from "../../src/schema/types.js";

function buildChatAppArchitecture(): Architecture {
  const arch = createEmptyArchitecture("my-chat-app", "Real-time chat application");
  arch.services = [
    { id: "web-client", name: "Web Client", type: "frontend", technology: "Next.js", description: "React app", dependencies: ["api-server", "websocket-server"] },
    { id: "api-server", name: "REST API", type: "backend", technology: "Next.js API Routes", description: "API", dependencies: ["database"] },
    { id: "websocket-server", name: "WebSocket Server", type: "backend", technology: "Socket.io", description: "Real-time", dependencies: ["database"] },
    { id: "database", name: "PostgreSQL", type: "database", technology: "PostgreSQL via Supabase", description: "Storage", dependencies: [] },
  ];
  arch.connections = [
    { from: "web-client", to: "api-server", protocol: "HTTP/REST", description: "API calls" },
    { from: "web-client", to: "websocket-server", protocol: "WebSocket", description: "Real-time" },
    { from: "api-server", to: "database", protocol: "TCP/SQL", description: "Queries" },
    { from: "websocket-server", to: "database", protocol: "TCP/SQL", description: "Persistence" },
  ];
  arch.decisions = [
    {
      id: "dec-001", topic: "Database Choice", decision: "PostgreSQL over MongoDB",
      rationale: "Relational data model fits chat.",
      alternatives: [{ name: "MongoDB", whyNot: "Document model adds complexity." }],
      timestamp: "2026-05-05T01:00:00Z", relatedServices: ["database"],
    },
  ];
  arch.dataFlows = [
    {
      name: "User sends a message",
      steps: [
        { actor: "web-client", action: "User types message" },
        { actor: "websocket-server", action: "Receives and persists" },
        { actor: "web-client", action: "Receives broadcast" },
      ],
    },
  ];
  return arch;
}

describe("Learning Mode Integration", () => {
  it("full flow: concepts → questions → answers → progress", () => {
    const arch = buildChatAppArchitecture();

    // 1. Extract concepts
    const concepts = extractConcepts(arch);
    expect(concepts.length).toBeGreaterThan(0);

    // 2. Generate questions
    const questions = generateAllQuestions(arch);
    expect(questions.length).toBeGreaterThan(0);

    // 3. Every question references a valid concept
    const conceptIds = new Set(concepts.map((c) => c.id));
    for (const q of questions) {
      expect(conceptIds.has(q.conceptId)).toBe(true);
    }

    // 4. Initialize progress and merge concepts
    let progress = createInitialProgress("my-chat-app");
    progress = mergeNewConcepts(progress, concepts);
    expect(progress.concepts.length).toBe(concepts.length);
    expect(progress.concepts.every((c) => !c.mastered)).toBe(true);

    // 5. Answer a question correctly
    const firstQ = questions[0];
    progress = recordAnswer(progress, firstQ.conceptId, "Test", firstQ.category, true);
    expect(progress.totalQuestions).toBe(1);
    expect(progress.correctAnswers).toBe(1);
    const mastered = progress.concepts.find((c) => c.conceptId === firstQ.conceptId);
    expect(mastered?.mastered).toBe(true);

    // 6. Answer a question incorrectly
    const secondQ = questions[1];
    progress = recordAnswer(progress, secondQ.conceptId, "Test", secondQ.category, false);
    expect(progress.totalQuestions).toBe(2);
    expect(progress.correctAnswers).toBe(1);
    const notMastered = progress.concepts.find((c) => c.conceptId === secondQ.conceptId);
    expect(notMastered?.mastered).toBe(false);
  });

  it("architecture changes add new concepts without losing mastery", () => {
    const arch = buildChatAppArchitecture();
    const concepts = extractConcepts(arch);

    let progress = createInitialProgress("my-chat-app");
    progress = mergeNewConcepts(progress, concepts);

    // Master one concept
    progress = recordAnswer(progress, concepts[0].id, concepts[0].label, concepts[0].category, true);

    // Architecture changes: add a new decision
    arch.decisions.push({
      id: "dec-new",
      topic: "Caching Strategy",
      decision: "Redis for sessions",
      rationale: "In-memory speed for session data.",
      alternatives: [{ name: "Database sessions", whyNot: "Slower for frequent lookups." }],
      timestamp: "2026-05-06T00:00:00Z",
      relatedServices: [],
    });

    const newConcepts = extractConcepts(arch);
    progress = mergeNewConcepts(progress, newConcepts);

    // Old mastery preserved
    const oldConcept = progress.concepts.find((c) => c.conceptId === concepts[0].id);
    expect(oldConcept?.mastered).toBe(true);

    // New concept added
    const newConcept = progress.concepts.find((c) => c.conceptId === "concept-dec-new");
    expect(newConcept).toBeDefined();
    expect(newConcept?.mastered).toBe(false);
  });
});
