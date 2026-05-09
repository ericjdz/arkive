import { describe, it, expect } from "vitest";
import { ServiceSchema, ConnectionSchema, DecisionSchema } from "../../src/schema/architecture.js";

describe("confidence and provenance fields", () => {
  const baseService = {
    id: "svc-1",
    name: "API",
    type: "backend" as const,
    technology: "Express",
    description: "Main API",
    dependencies: [],
  };

  it("accepts service without source/confidence (backward compat)", () => {
    const result = ServiceSchema.safeParse(baseService);
    expect(result.success).toBe(true);
  });

  it("accepts service with source and confidence", () => {
    const result = ServiceSchema.safeParse({
      ...baseService,
      source: "agent-scanned",
      confidence: 0.8,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe("agent-scanned");
      expect(result.data.confidence).toBe(0.8);
    }
  });

  it("rejects invalid source value", () => {
    const result = ServiceSchema.safeParse({
      ...baseService,
      source: "magic",
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence outside 0-1 range", () => {
    const under = ServiceSchema.safeParse({ ...baseService, confidence: -0.1 });
    const over = ServiceSchema.safeParse({ ...baseService, confidence: 1.5 });
    expect(under.success).toBe(false);
    expect(over.success).toBe(false);
  });

  it("accepts connection with source and confidence", () => {
    const result = ConnectionSchema.safeParse({
      from: "a",
      to: "b",
      protocol: "HTTP",
      description: "calls",
      source: "inferred",
      confidence: 0.5,
    });
    expect(result.success).toBe(true);
  });

  it("accepts decision with source and confidence", () => {
    const result = DecisionSchema.safeParse({
      id: "dec-1",
      topic: "DB choice",
      decision: "Postgres",
      rationale: "Relational data",
      alternatives: [{ name: "Mongo", whyNot: "Not relational" }],
      timestamp: "2026-05-09T00:00:00.000Z",
      source: "human-verified",
      confidence: 1.0,
    });
    expect(result.success).toBe(true);
  });
});
