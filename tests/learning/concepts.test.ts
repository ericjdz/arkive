import { describe, it, expect } from "vitest";
import { extractConcepts } from "../../src/learning/concepts.js";
import type { Architecture } from "../../src/schema/types.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";

function buildChatAppArchitecture(): Architecture {
  const arch = createEmptyArchitecture("my-chat-app", "Real-time chat application");
  arch.services = [
    {
      id: "web-client",
      name: "Web Client",
      type: "frontend",
      technology: "Next.js",
      description: "Server-rendered React app with real-time chat UI",
      dependencies: ["api-server", "websocket-server"],
    },
    {
      id: "api-server",
      name: "REST API",
      type: "backend",
      technology: "Next.js API Routes",
      description: "Handles auth, CRUD, business logic",
      dependencies: ["database"],
    },
    {
      id: "websocket-server",
      name: "WebSocket Server",
      type: "backend",
      technology: "Socket.io",
      description: "Real-time message delivery",
      dependencies: ["database"],
    },
    {
      id: "database",
      name: "PostgreSQL",
      type: "database",
      technology: "PostgreSQL via Supabase",
      description: "Persistent storage for users, messages, channels",
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
      id: "dec-001",
      topic: "Database Choice",
      decision: "PostgreSQL over MongoDB",
      rationale: "Relational data model fits chat. Strong consistency for message ordering.",
      alternatives: [
        { name: "MongoDB", whyNot: "Document model adds complexity for relational queries." },
        { name: "Redis", whyNot: "Not suitable as primary persistent store." },
      ],
      timestamp: "2026-05-05T01:00:00Z",
      relatedServices: ["database"],
    },
    {
      id: "dec-002",
      topic: "Real-time Strategy",
      decision: "Socket.io over Supabase Realtime",
      rationale: "More control over room management, typing indicators, presence.",
      alternatives: [
        { name: "Supabase Realtime", whyNot: "Tied to database changes." },
        { name: "Server-Sent Events", whyNot: "Unidirectional." },
      ],
      timestamp: "2026-05-05T01:30:00Z",
      relatedServices: ["websocket-server", "web-client"],
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

describe("extractConcepts", () => {
  it("extracts one concept per decision", () => {
    const arch = buildChatAppArchitecture();
    const concepts = extractConcepts(arch);
    const decisionConcepts = concepts.filter((c) => c.category === "decision");
    expect(decisionConcepts).toHaveLength(2);
    expect(decisionConcepts[0].id).toBe("concept-dec-001");
    expect(decisionConcepts[0].label).toBe("Database Choice");
  });

  it("extracts one concept per service", () => {
    const arch = buildChatAppArchitecture();
    const concepts = extractConcepts(arch);
    const serviceConcepts = concepts.filter((c) => c.category === "topology");
    expect(serviceConcepts).toHaveLength(4);
  });

  it("extracts one concept per connection", () => {
    const arch = buildChatAppArchitecture();
    const concepts = extractConcepts(arch);
    const connectionConcepts = concepts.filter((c) => c.category === "connection");
    expect(connectionConcepts).toHaveLength(4);
  });

  it("extracts one concept per data flow", () => {
    const arch = buildChatAppArchitecture();
    const concepts = extractConcepts(arch);
    const flowConcepts = concepts.filter((c) => c.category === "data-flow");
    expect(flowConcepts).toHaveLength(1);
    expect(flowConcepts[0].label).toBe("User sends a message");
  });

  it("returns empty array for empty architecture", () => {
    const arch = createEmptyArchitecture("empty", "Nothing here");
    const concepts = extractConcepts(arch);
    expect(concepts).toHaveLength(0);
  });

  it("assigns unique IDs to all concepts", () => {
    const arch = buildChatAppArchitecture();
    const concepts = extractConcepts(arch);
    const ids = concepts.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
