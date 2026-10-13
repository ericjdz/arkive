import { describe, it, expect } from "vitest";
import { generateMarkdown } from "../../src/export/markdown.js";

const CHAT_APP = {
  version: "1.0.0",
  project: {
    name: "my-chat-app",
    description: "Real-time chat application",
    created: "2026-05-05T00:00:00Z",
    lastUpdated: "2026-05-05T12:00:00Z",
  },
  stack: {
    language: ["TypeScript"],
    runtime: ["Node.js", "Browser"],
    framework: ["Next.js"],
    database: ["PostgreSQL"],
    infrastructure: ["Vercel", "Supabase"],
  },
  services: [
    { id: "web-client", name: "Web Client", type: "frontend", technology: "Next.js", description: "Server-rendered React app", dependencies: ["api-server"] },
    { id: "api-server", name: "REST API", type: "backend", technology: "Next.js API Routes", description: "Handles auth, CRUD", dependencies: ["database"] },
    { id: "database", name: "PostgreSQL", type: "database", technology: "PostgreSQL via Supabase", description: "Persistent storage", dependencies: [] },
  ],
  connections: [
    { from: "web-client", to: "api-server", protocol: "HTTP/REST", description: "Auth, channel management" },
    { from: "api-server", to: "database", protocol: "TCP/SQL", description: "Prisma ORM queries" },
  ],
  decisions: [
    {
      id: "dec-001",
      topic: "Database Choice",
      decision: "PostgreSQL over MongoDB",
      rationale: "Relational data model fits chat",
      alternatives: [{ name: "MongoDB", whyNot: "Document model adds complexity" }],
      timestamp: "2026-05-05T01:00:00Z",
      relatedServices: ["database"],
    },
  ],
  dataFlows: [
    {
      name: "User sends a message",
      steps: [
        { actor: "web-client", action: "User types message" },
        { actor: "api-server", action: "Validates and persists" },
      ],
    },
  ],
  history: [],
};

describe("generateMarkdown", () => {
  it("includes project name as heading", () => {
    const result = generateMarkdown(CHAT_APP);
    expect(result).toContain("# my-chat-app");
  });

  it("includes a stack table", () => {
    const result = generateMarkdown(CHAT_APP);
    expect(result).toContain("## Technology Stack");
    expect(result).toContain("TypeScript");
    expect(result).toContain("Next.js");
    expect(result).toContain("PostgreSQL");
  });

  it("includes a services table with all columns", () => {
    const result = generateMarkdown(CHAT_APP);
    expect(result).toContain("## Services");
    expect(result).toContain("| Name |");
    expect(result).toContain("Web Client");
    expect(result).toContain("REST API");
  });

  it("includes a connections table", () => {
    const result = generateMarkdown(CHAT_APP);
    expect(result).toContain("## Connections");
    expect(result).toContain("HTTP/REST");
    expect(result).toContain("TCP/SQL");
  });

  it("includes decisions with alternatives", () => {
    const result = generateMarkdown(CHAT_APP);
    expect(result).toContain("## Architectural Decisions");
    expect(result).toContain("Database Choice");
    expect(result).toContain("PostgreSQL over MongoDB");
    expect(result).toContain("MongoDB");
    expect(result).toContain("Document model adds complexity");
  });

  it("includes data flows as numbered steps", () => {
    const result = generateMarkdown(CHAT_APP);
    expect(result).toContain("## Data Flows");
    expect(result).toContain("User sends a message");
    expect(result).toContain("1.");
  });

  it("handles empty architecture gracefully", () => {
    const empty = {
      version: "1.0.0",
      project: { name: "empty", description: "", created: "", lastUpdated: "" },
      stack: { language: [], runtime: [], framework: [], database: [], infrastructure: [] },
      services: [],
      connections: [],
      decisions: [],
      dataFlows: [],
      history: [],
    };
    const result = generateMarkdown(empty);
    expect(result).toContain("# empty");
    expect(result).not.toContain("undefined");
  });
});
