import { describe, it, expect } from "vitest";
import {
  validateGraphDocument,
  createEmptyArchitectureV2,
} from "../../src/schema/validate-graph.js";
import { authoredBy, derivedFrom } from "../../src/schema/provenance.js";
import type { ArchitectureDocumentV2 } from "../../src/schema/graph.js";

/**
 * Zod checks shape. These are the invariants it cannot check
 * (`docs/issues/0003-graph-schema-v2.md` §6), split into the two classes that
 * matter: an error means the graph lies about structure, a warning means it is
 * merely incomplete — and ADR-0001:146-149 is explicit that incomplete things
 * are reported, never deleted.
 */

function baseDocument(): ArchitectureDocumentV2 {
  return createEmptyArchitectureV2("demo", "A demo project");
}

const dbNode = {
  id: "db",
  kind: "datastore" as const,
  name: "Primary store",
  summary: "Stores everything",
  tech: "SQLite",
  provenance: authoredBy("human"),
};

const readsEdge = {
  id: "reads:api->db",
  from: "api",
  to: "db",
  kind: "reads" as const,
  provenance: derivedFrom("call-graph", ["src/api/repo.ts:31"]),
};

const apiNode = {
  id: "api",
  kind: "service" as const,
  name: "API",
  summary: "s",
  provenance: authoredBy("agent"),
};

function withGraph(overrides: Partial<ArchitectureDocumentV2> = {}): ArchitectureDocumentV2 {
  return {
    ...baseDocument(),
    nodes: [apiNode, dbNode],
    edges: [readsEdge],
    ...overrides,
  };
}

function errorOf(result: ReturnType<typeof validateGraphDocument>): string {
  if (result.success) {
    throw new Error(`expected failure, got success`);
  }
  return result.error;
}

function warningCodes(result: ReturnType<typeof validateGraphDocument>): string[] {
  if (!result.success) {
    throw new Error(`expected success, got: ${result.error}`);
  }
  return result.warnings.map((warning) => warning.code);
}

describe("validateGraphDocument — integrity errors", () => {
  it("accepts a well-formed graph", () => {
    const result = validateGraphDocument(withGraph());
    expect(result.success).toBe(true);
  });

  it("rejects duplicate node ids", () => {
    const error = errorOf(
      validateGraphDocument(withGraph({ nodes: [apiNode, { ...apiNode, name: "Other" }] }))
    );
    expect(error).toContain("duplicate node id");
    expect(error).toContain("api");
  });

  it("rejects duplicate edge ids", () => {
    const error = errorOf(
      validateGraphDocument(withGraph({ edges: [readsEdge, { ...readsEdge }] }))
    );
    expect(error).toContain("duplicate edge id");
  });

  it("rejects duplicate decision ids", () => {
    const decision = {
      id: "dec-1",
      topic: "t",
      decision: "d",
      rationale: "r",
      alternatives: [{ name: "n", whyNot: "w" }],
      timestamp: "2026-05-09T00:00:00.000Z",
      subjects: [{ kind: "node" as const, ref: "db" }],
    };
    const error = errorOf(
      validateGraphDocument(withGraph({ decisions: [decision, { ...decision }] }))
    );
    expect(error).toContain("duplicate decision id");
  });

  it("rejects an edge with a dangling endpoint", () => {
    const error = errorOf(
      validateGraphDocument(withGraph({ edges: [{ ...readsEdge, from: "ghost" }] }))
    );
    expect(error).toContain("unknown node");
    expect(error).toContain("ghost");
  });

  it("rejects a decided_by edge whose from-endpoint is not a live node", () => {
    // A `decided_by` edge's `to` is a decision, but its `from` is still a node.
    const error = errorOf(
      validateGraphDocument(
        withGraph({
          decisions: [
            {
              id: "dec-1",
              topic: "t",
              decision: "d",
              rationale: "r",
              alternatives: [{ name: "n", whyNot: "w" }],
              timestamp: "2026-05-09T00:00:00.000Z",
              subjects: [],
            },
          ],
          edges: [
            {
              id: "decided_by:ghost->dec-1",
              from: "ghost",
              to: "dec-1",
              kind: "decided_by",
              provenance: derivedFrom("decision-join", ["src/schema/migrate.ts:12"]),
            },
          ],
        })
      )
    );
    expect(error).toContain("unknown node");
    expect(error).toContain("ghost");
  });

  it("rejects an edge pointing at a tombstoned node", () => {
    const error = errorOf(
      validateGraphDocument(
        withGraph({
          nodes: [apiNode, { ...dbNode, deletedAt: "2026-05-09T00:00:00.000Z" }],
        })
      )
    );
    expect(error).toContain("tombstoned node");
  });

  it("rejects a decided_by edge that references no decision", () => {
    const error = errorOf(
      validateGraphDocument(
        withGraph({
          edges: [
            {
              id: "decided_by:db->dec-1",
              from: "db",
              to: "dec-1",
              kind: "decided_by",
              provenance: derivedFrom("decision-join", ["src/schema/migrate.ts:12"]),
            },
          ],
        })
      )
    );
    expect(error).toContain("decided_by");
    expect(error).toContain("unknown decision");
  });

  it("reports a shape failure before any invariant", () => {
    const error = errorOf(validateGraphDocument({ ...baseDocument(), nodes: [{ id: "" }] }));
    expect(error).toContain("nodes.0");
  });

  it("keeps the warnings gathered before a failure, so one fix does not hide the next", () => {
    const result = validateGraphDocument(
      withGraph({
        nodes: [
          apiNode,
          dbNode,
          // evidences a problem, and is then duplicated so a later invariant fails
          { ...apiNode, name: "Dup", provenance: derivedFrom("r", ["no line here"]) },
        ],
        edges: [{ ...readsEdge, from: "ghost" }],
      })
    );
    expect(result.success).toBe(false);
    expect(result.warnings.map((w) => w.code)).toContain("evidence-without-location");
  });
});

describe("validateGraphDocument — warnings, not errors", () => {
  const decision = {
    id: "dec-1",
    topic: "t",
    decision: "d",
    rationale: "r",
    alternatives: [{ name: "n", whyNot: "w" }],
    timestamp: "2026-05-09T00:00:00.000Z",
    subjects: [{ kind: "node" as const, ref: "db" }],
  };

  it("accepts a stored decided_by edge that resolves, and flags it as derived", () => {
    const result = validateGraphDocument(
      withGraph({
        decisions: [decision],
        edges: [
          {
            id: "decided_by:db->dec-1",
            from: "db",
            to: "dec-1",
            kind: "decided_by",
            provenance: derivedFrom("decision-join", ["src/schema/migrate.ts:12"]),
          },
        ],
      })
    );
    expect(result.success).toBe(true);
    expect(warningCodes(result)).toContain("decided-by-stored");
  });

  it("accepts a preserved dangling edge and reports it", () => {
    const result = validateGraphDocument(
      withGraph({
        edges: [{ ...readsEdge, from: "ghost", dangling: true }],
      })
    );
    expect(result.success).toBe(true);
    expect(warningCodes(result)).toContain("dangling-edge");
  });

  it("reports a decision that explains something which no longer exists", () => {
    // ADR-0002:105-107 rule 2. Deleting the subject must not delete the
    // rationale, so this can never be an error.
    const result = validateGraphDocument(
      withGraph({
        decisions: [
          {
            ...decision,
            subjects: [
              { kind: "node", ref: "db" },
              { kind: "node", ref: "gone" },
              { kind: "edge", ref: "gone-edge" },
            ],
          },
        ],
      })
    );
    expect(result.success).toBe(true);
    const warnings = warningCodes(result).filter((code) => code === "unresolved-subject");
    expect(warnings).toHaveLength(2);
  });

  it("reports a tombstoned node so a soft delete is visible", () => {
    const result = validateGraphDocument(
      withGraph({
        nodes: [apiNode, { ...dbNode, deletedAt: "2026-05-09T00:00:00.000Z" }],
        edges: [],
      })
    );
    expect(result.success).toBe(true);
    expect(warningCodes(result)).toContain("tombstoned-node");
  });

  it("reports evidence that is not a file:line locator", () => {
    const result = validateGraphDocument(
      withGraph({
        edges: [{ ...readsEdge, provenance: derivedFrom("call-graph", ["the api layer"]) }],
      })
    );
    expect(result.success).toBe(true);
    expect(warningCodes(result)).toContain("evidence-without-location");
  });

  it("points every warning at the element that caused it", () => {
    const result = validateGraphDocument(
      withGraph({
        decisions: [{ ...decision, subjects: [{ kind: "node", ref: "gone" }] }],
      })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const warning = result.warnings.find((w) => w.code === "unresolved-subject");
      expect(warning?.path).toBe("decisions.0.subjects.0");
      expect(warning?.message).toContain("dec-1");
      expect(warning?.message).toContain("gone");
    }
  });
});

describe("createEmptyArchitectureV2", () => {
  it("starts at the current version with no defaults invented", () => {
    const document = createEmptyArchitectureV2("fresh", "brand new");
    expect(document.schemaVersion).toBe(2);
    expect(document.nodes).toEqual([]);
    expect(document.edges).toEqual([]);
    expect(validateGraphDocument(document).success).toBe(true);
  });

  it("uses ISO-8601 timestamps", () => {
    const document = createEmptyArchitectureV2("fresh", "brand new");
    expect(document.project.created).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(document.history[0].action).toBe("initial_scaffold");
  });
});
