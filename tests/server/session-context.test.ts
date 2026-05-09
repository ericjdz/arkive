import { describe, it, expect } from "vitest";
import { buildSessionContext } from "../../src/server/session-context.js";
import type { Architecture } from "../../src/schema/types.js";

function makeArch(overrides: Partial<Architecture> = {}): Architecture {
  return {
    version: "1.0.0",
    project: {
      name: "test-project",
      description: "A test project",
      created: "2026-01-01T00:00:00.000Z",
      lastUpdated: "2026-05-09T00:00:00.000Z",
    },
    stack: {
      language: ["TypeScript"],
      runtime: ["Node.js"],
      framework: ["Express"],
      database: ["Postgres"],
      infrastructure: [],
    },
    services: [
      { id: "api", name: "API", type: "backend", technology: "Express", description: "Main API server", dependencies: [] },
      { id: "web", name: "Web", type: "frontend", technology: "React", description: "SPA frontend", dependencies: ["api"] },
      { id: "db", name: "Database", type: "database", technology: "Postgres", description: "Primary store", dependencies: [] },
    ],
    connections: [
      { from: "web", to: "api", protocol: "HTTP", description: "REST calls" },
      { from: "api", to: "db", protocol: "TCP", description: "SQL queries" },
    ],
    decisions: [
      {
        id: "dec-1", topic: "Database", decision: "Postgres", rationale: "Relational",
        alternatives: [{ name: "Mongo", whyNot: "Not relational" }],
        timestamp: "2026-01-01T00:00:00.000Z", relatedServices: ["db"],
      },
    ],
    dataFlows: [
      { name: "User Login", steps: [{ actor: "User", action: "Submits credentials" }, { actor: "API", action: "Validates" }] },
    ],
    history: [
      { timestamp: "2026-01-01T00:00:00.000Z", action: "init", summary: "Project initialized" },
      { timestamp: "2026-05-09T00:00:00.000Z", action: "add_api", summary: "Added API service" },
    ],
    ...overrides,
  };
}

describe("buildSessionContext", () => {
  it("returns compact markdown summary", () => {
    const ctx = buildSessionContext(makeArch());
    expect(ctx).toContain("test-project");
    expect(ctx).toContain("TypeScript");
    expect(ctx).toContain("API");
    expect(ctx).toContain("web → api");
    expect(ctx).toContain("Database");
    // Should NOT contain full rationale or step-by-step flows
    expect(ctx).not.toContain("Validates");
  });

  it("respects maxTokens by truncating history and decisions", () => {
    const ctx = buildSessionContext(makeArch(), { maxTokens: 200 });
    // Rough check: 200 tokens ≈ 800 chars
    expect(ctx.length).toBeLessThan(1200);
  });

  it("includes low-confidence warnings", () => {
    const arch = makeArch({
      services: [
        { id: "api", name: "API", type: "backend", technology: "Express", description: "Main API", dependencies: [], source: "inferred" as any, confidence: 0.4 as any },
      ],
    });
    const ctx = buildSessionContext(arch);
    expect(ctx).toContain("low confidence");
  });

  it("handles empty architecture gracefully", () => {
    const arch = makeArch({
      services: [],
      connections: [],
      decisions: [],
      dataFlows: [],
      history: [],
    });
    const ctx = buildSessionContext(arch);
    expect(ctx).toContain("test-project");
    expect(ctx).toContain("No services");
  });
});
