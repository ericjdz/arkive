import { describe, it, expect } from "vitest";
import { validateArchitecture, createEmptyArchitecture } from "../../src/schema/validate.js";
import { DecisionSchema } from "../../src/schema/architecture.js";

describe("Architecture Schema", () => {
  it("validates a minimal valid architecture", () => {
    const arch = createEmptyArchitecture("test-project", "A test project");
    const result = validateArchitecture(arch);
    expect(result.success).toBe(true);
  });

  it("rejects architecture missing project name", () => {
    const arch = createEmptyArchitecture("test-project", "A test project");
    // Setting name to empty string — valid TS but rejected by Zod min(1)
    arch.project.name = "";
    const result = validateArchitecture(arch);
    expect(result.success).toBe(false);
  });

  it("validates architecture with services and connections", () => {
    const arch = createEmptyArchitecture("chat-app", "Real-time chat");
    arch.services.push({
      id: "web-client",
      name: "Web Client",
      type: "frontend",
      technology: "Next.js",
      description: "Server-rendered React app",
      dependencies: ["api-server"],
    });
    arch.services.push({
      id: "api-server",
      name: "API Server",
      type: "backend",
      technology: "Express",
      description: "REST API",
      dependencies: ["database"],
    });
    arch.services.push({
      id: "database",
      name: "Database",
      type: "database",
      technology: "PostgreSQL",
      description: "Primary data store",
      dependencies: [],
    });
    arch.connections.push({
      from: "web-client",
      to: "api-server",
      protocol: "HTTP/REST",
      description: "API calls",
    });
    const result = validateArchitecture(arch);
    expect(result.success).toBe(true);
  });

  it("validates architecture with decisions", () => {
    const arch = createEmptyArchitecture("my-app", "My app");
    arch.decisions.push({
      id: "dec-001",
      topic: "Database Choice",
      decision: "PostgreSQL",
      rationale: "Relational data model fits the domain",
      alternatives: [
        { name: "MongoDB", whyNot: "Document model adds complexity" },
      ],
      timestamp: new Date().toISOString(),
      relatedServices: ["database"],
    });
    const result = validateArchitecture(arch);
    expect(result.success).toBe(true);
  });

  it("rejects decision with empty alternatives", () => {
    const result = DecisionSchema.safeParse({
      id: "dec-001",
      topic: "Test",
      decision: "Chose X",
      rationale: "Because",
      alternatives: [],
      timestamp: new Date().toISOString(),
      relatedServices: [],
    });
    expect(result.success).toBe(false);
  });

  it("validates architecture with data flows", () => {
    const arch = createEmptyArchitecture("my-app", "My app");
    arch.dataFlows.push({
      name: "User login",
      steps: [
        { actor: "web-client", action: "User submits credentials" },
        { actor: "api-server", action: "Validates credentials against DB" },
        { actor: "api-server", action: "Returns JWT token" },
      ],
    });
    const result = validateArchitecture(arch);
    expect(result.success).toBe(true);
  });

  it("rejects connection referencing nonexistent service", () => {
    const arch = createEmptyArchitecture("my-app", "My app");
    arch.connections.push({
      from: "nonexistent",
      to: "also-nonexistent",
      protocol: "HTTP",
      description: "Bad connection",
    });
    const result = validateArchitecture(arch);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("nonexistent");
    }
  });
});
