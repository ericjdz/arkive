import { describe, it, expect } from "vitest";
import {
  ArchitectureDocumentV2Schema,
  CURRENT_SCHEMA_VERSION,
  NodeSchema,
  EdgeSchema,
  GraphDocumentSchema,
  NodeKindSchema,
  EdgeKindSchema,
  GraphDecisionSchema,
} from "../../src/schema/graph.js";
import { authoredBy, derivedFrom } from "../../src/schema/provenance.js";
import { createEmptyArchitectureV2 } from "../../src/schema/validate-graph.js";

const serviceNode = {
  id: "api",
  kind: "service" as const,
  name: "API Server",
  summary: "REST API",
  tech: "Express",
  provenance: authoredBy("human", "2026-05-09T00:00:00.000Z"),
};

const callsEdge = {
  id: "calls:web->api",
  from: "web",
  to: "api",
  kind: "calls" as const,
  label: "HTTP/REST",
  provenance: derivedFrom("import-graph", ["src/web/index.ts:12"]),
};

function documentWith(overrides: Record<string, unknown> = {}) {
  return {
    ...createEmptyArchitectureV2("demo", "A demo project"),
    nodes: [serviceNode],
    edges: [{ ...callsEdge, dangling: true }],
    ...overrides,
  };
}

describe("graph schema v2 — node kinds", () => {
  it("accepts exactly the six kinds ADR-0001 names", () => {
    expect(NodeKindSchema.options.sort()).toEqual([
      "datastore",
      "datastructure",
      "endpoint",
      "external",
      "module",
      "service",
    ]);
  });

  it("rejects the v1 ServiceType taxonomy as a kind", () => {
    // `frontend`, `cache`, `queue` etc. are deployment concerns, not structure.
    // ADR-0001:65-68 deletes the enum rather than translating it.
    expect(NodeKindSchema.safeParse("cache").success).toBe(false);
    expect(NodeKindSchema.safeParse("frontend").success).toBe(false);
    expect(NodeKindSchema.safeParse("backend").success).toBe(false);
  });

  it("accepts every documented kind on a node", () => {
    for (const kind of NodeKindSchema.options) {
      const result = NodeSchema.safeParse({
        id: `n-${kind}`,
        kind,
        name: kind,
        summary: "",
        provenance: authoredBy("agent"),
      });
      expect(result.success, `${kind} should parse`).toBe(true);
    }
  });

  it("requires provenance — it cannot be structurally omitted", () => {
    const { provenance: _omitted, ...withoutProvenance } = serviceNode;
    expect(NodeSchema.safeParse(withoutProvenance).success).toBe(false);
  });

  it("requires a summary even when it is empty", () => {
    const { summary: _omitted, ...withoutSummary } = serviceNode;
    expect(NodeSchema.safeParse(withoutSummary).success).toBe(false);
    expect(NodeSchema.safeParse({ ...serviceNode, summary: "" }).success).toBe(true);
  });
});

describe("graph schema v2 — edge kinds", () => {
  it("accepts exactly the six kinds ADR-0001 names", () => {
    expect(EdgeKindSchema.options.sort()).toEqual([
      "calls",
      "decided_by",
      "derives_from",
      "imports",
      "reads",
      "writes",
    ]);
  });

  it("gives an edge an id, because a decision must be able to name it", () => {
    const { id: _omitted, ...withoutId } = callsEdge;
    expect(EdgeSchema.safeParse(withoutId).success).toBe(false);
  });

  it("treats label as transport naming, not semantics", () => {
    // Same label, different kinds, both valid — label carries no semantics.
    const http = EdgeSchema.safeParse({ ...callsEdge, kind: "calls", label: "HTTP/REST" });
    const read = EdgeSchema.safeParse({ ...callsEdge, kind: "reads", label: "HTTP/REST" });
    expect(http.success).toBe(true);
    expect(read.success).toBe(true);
    if (http.success && read.success) {
      expect(http.data.kind).toBe("calls");
      expect(read.data.kind).toBe("reads");
    }
  });
});

describe("graph schema v2 — schemaVersion is real", () => {
  it("has no default, so a v1 document cannot parse as v2", () => {
    const v1 = { version: "1.0.0", project: { name: "x" } };
    expect(ArchitectureDocumentV2Schema.safeParse(v1).success).toBe(false);
    const result = ArchitectureDocumentV2Schema.safeParse(v1);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "schemaVersion")).toBe(
        true
      );
    }
  });

  it("accepts the current version", () => {
    const result = ArchitectureDocumentV2Schema.safeParse(createEmptyArchitectureV2("x", "y"));
    expect(result.success).toBe(true);
  });

  it("treats an unknown major as a hard error, not a best-effort parse", () => {
    const future = { ...createEmptyArchitectureV2("x", "y"), schemaVersion: 3 };
    const result = ArchitectureDocumentV2Schema.safeParse(future);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join("."))).toContain("schemaVersion");
    }
  });

  it("exposes the version as a number, not a semver string", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
    const parsed = ArchitectureDocumentV2Schema.parse(
      createEmptyArchitectureV2("x", "y")
    );
    expect(typeof parsed.schemaVersion).toBe("number");
    expect(parsed).not.toHaveProperty("version");
  });

  it("keeps the version-agnostic container usable by the probe", () => {
    const future = { ...createEmptyArchitectureV2("x", "y"), schemaVersion: 99 };
    expect(GraphDocumentSchema.safeParse(future).success).toBe(true);
    expect(ArchitectureDocumentV2Schema.safeParse(future).success).toBe(false);
  });
});

describe("graph schema v2 — confidence does not survive", () => {
  it("declares no confidence field on nodes or edges", () => {
    // The claim ADR-0002 makes is that no v2 code path can read or write it.
    // `confidence` is absent from the schema shape, so nothing validates,
    // produces, or consumes it.
    expect(Object.keys(NodeSchema.shape)).not.toContain("confidence");
    expect(Object.keys(EdgeSchema.shape)).not.toContain("confidence");
    expect(Object.keys(NodeSchema.shape)).not.toContain("source");
    expect(Object.keys(EdgeSchema.shape)).not.toContain("source");
  });

  it("accepts a hand-written confidence key only as an inert extension", () => {
    // `looseObject` (ADR-0006 §3) keeps it verbatim so a user's file is not
    // silently edited. It is not a field: no code path reads it, and it is not
    // promoted into provenance.
    const parsed = NodeSchema.parse({ ...serviceNode, confidence: 0.8 });
    expect(parsed.confidence).toBe(0.8);
    expect(parsed.provenance).toEqual({
      derived: false,
      authoredBy: "human",
      reviewedAt: "2026-05-09T00:00:00.000Z",
    });
  });
});

describe("graph schema v2 — decisions own their subjects", () => {
  const decision = {
    id: "dec-001",
    topic: "Store choice",
    decision: "SQLite",
    rationale: "Single file, no service to run",
    alternatives: [{ name: "Postgres", whyNot: "Operational cost for a single-user tool" }],
    timestamp: "2026-05-09T00:00:00.000Z",
    subjects: [{ kind: "node" as const, ref: "store" }],
  };

  it("accepts node and edge subjects", () => {
    const result = ArchitectureDocumentV2Schema.safeParse({
      ...createEmptyArchitectureV2("x", "y"),
      nodes: [serviceNode],
      decisions: [decision, { ...decision, id: "dec-002", subjects: [{ kind: "edge", ref: "e1" }] }],
    });
    expect(result.success).toBe(true);
  });

  it("declares no relatedServices — the id-of-what array is gone", () => {
    // v1's `relatedServices: string[]` could not say whether it pointed at a
    // node or an edge. `subjects` says which, which is what lets `decided_by`
    // be a projection (ADR-0001:78-88).
    const decisionShape = Object.keys(GraphDecisionSchema.shape);
    expect(decisionShape).toContain("subjects");
    expect(decisionShape).not.toContain("relatedServices");
  });

  it("reads subjects, leaving a stray v1 relatedServices as an inert extension", () => {
    const parsed = ArchitectureDocumentV2Schema.parse({
      ...createEmptyArchitectureV2("x", "y"),
      decisions: [{ ...decision, relatedServices: ["store"] }],
    });
    expect(parsed.decisions[0].subjects).toEqual([{ kind: "node", ref: "store" }]);
    expect(parsed.decisions[0].relatedServices).toEqual(["store"]);
  });

  it("still requires at least one rejected alternative", () => {
    const result = ArchitectureDocumentV2Schema.safeParse({
      ...createEmptyArchitectureV2("x", "y"),
      decisions: [{ ...decision, alternatives: [] }],
    });
    expect(result.success).toBe(false);
  });
});

describe("graph schema v2 — document shape", () => {
  it("stores no services[] or connections[]", () => {
    const parsed = ArchitectureDocumentV2Schema.parse(documentWith());
    expect(parsed).not.toHaveProperty("services");
    expect(parsed).not.toHaveProperty("connections");
  });

  it("keeps dataFlows as a separate authored array", () => {
    // ADR-0001:151-157 — a data flow is an ordered narrative, consumed as one.
    const parsed = ArchitectureDocumentV2Schema.parse(
      documentWith({
        dataFlows: [{ name: "login", steps: [{ actor: "web", action: "submits" }] }],
      })
    );
    expect(parsed.dataFlows).toHaveLength(1);
  });

  it("rejects a document with no project", () => {
    const { project: _dropped, ...noProject } = documentWith();
    expect(ArchitectureDocumentV2Schema.safeParse(noProject).success).toBe(false);
  });
});
