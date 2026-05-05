import { describe, it, expect } from "vitest";
import { generateMermaid } from "../../src/viewer/src/utils/mermaid.js";

const CHAT_APP = {
  services: [
    { id: "web-client", name: "Web Client", type: "frontend", technology: "Next.js", description: "UI", dependencies: ["api-server", "websocket-server"] },
    { id: "api-server", name: "REST API", type: "backend", technology: "Next.js API Routes", description: "API", dependencies: ["database"] },
    { id: "websocket-server", name: "WebSocket Server", type: "backend", technology: "Socket.io", description: "Real-time", dependencies: ["database"] },
    { id: "database", name: "PostgreSQL", type: "database", technology: "PostgreSQL via Supabase", description: "Storage", dependencies: [] },
  ],
  connections: [
    { from: "web-client", to: "api-server", protocol: "HTTP/REST", description: "Auth, CRUD" },
    { from: "web-client", to: "websocket-server", protocol: "WebSocket", description: "Real-time messages" },
    { from: "api-server", to: "database", protocol: "TCP/SQL", description: "Prisma ORM" },
    { from: "websocket-server", to: "database", protocol: "TCP/SQL", description: "Message persistence" },
  ],
};

describe("generateMermaid", () => {
  it("generates a valid Mermaid graph with nodes and edges", () => {
    const result = generateMermaid(CHAT_APP.services, CHAT_APP.connections);
    expect(result).toContain("graph TD");
    expect(result).toContain("web-client");
    expect(result).toContain("api-server");
    expect(result).toContain("database");
    expect(result).toContain("HTTP/REST");
  });

  it("labels nodes with service name and technology", () => {
    const result = generateMermaid(CHAT_APP.services, CHAT_APP.connections);
    expect(result).toContain('web-client["Web Client<br/><small>Next.js</small>"]');
  });

  it("labels edges with protocol", () => {
    const result = generateMermaid(CHAT_APP.services, CHAT_APP.connections);
    expect(result).toMatch(/web-client -->|.*HTTP\/REST.*| api-server/);
  });

  it("uses different shapes for different service types", () => {
    const result = generateMermaid(CHAT_APP.services, CHAT_APP.connections);
    expect(result).toContain("database[");
    expect(result).toContain("web-client[");
  });

  it("handles empty services and connections", () => {
    const result = generateMermaid([], []);
    expect(result).toContain("graph TD");
    expect(result.trim().split("\n")).toHaveLength(1);
  });

  it("generates sequence diagram for data flows", () => {
    const flow = {
      name: "User sends a message",
      steps: [
        { actor: "web-client", action: "User types message, hits send" },
        { actor: "websocket-server", action: "Receives and persists" },
        { actor: "database", action: "INSERT into messages" },
      ],
    };
    const result = generateMermaid(CHAT_APP.services, CHAT_APP.connections, flow);
    expect(result).toContain("sequenceDiagram");
    expect(result).toContain("Web Client");
    expect(result).toContain("User types message");
  });
});
