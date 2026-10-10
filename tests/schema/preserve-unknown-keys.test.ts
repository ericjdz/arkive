import { describe, it, expect } from "vitest";
import {
  ArchitectureDocumentV2Schema,
  GraphDocumentSchema,
  NodeSchema,
  EdgeSchema,
} from "../../src/schema/graph.js";
import { ProvenanceSchema } from "../../src/schema/provenance.js";
import { validateGraphDocument } from "../../src/schema/validate-graph.js";

/**
 * ADR-0006 §3: "Validate into a side channel; write the original object."
 *
 * Zod v4's `z.object()` strips unknown keys, and `writeArchitecture` writes the
 * validated output (`src/io/architecture-file.ts:89`). So any key arkive does
 * not recognise is destroyed by the next write.
 *
 * ADR-0006 rejects `.passthrough()` as the *whole* strategy, for one reason:
 * the parse result is a Zod-reconstructed object with defaulted fields
 * materialised into it, so a future schema default writes itself into the
 * user's document. This module removes that reason instead of ignoring it —
 * the v2 schema is defaultless, so `parse(x)` is deep-equal to `x` and
 * `looseObject` is free. The first test below is the proof; the rest are the
 * guarantee.
 */

/** A document with a user extension at every level arkive knows about. */
function documentWithExtensions(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    "x-document-level": { addedBy: "hand", ticket: "OPS-119" },
    project: {
      name: "chat-app",
      description: "Real-time chat",
      created: "2026-05-09T00:00:00.000Z",
      lastUpdated: "2026-05-09T00:00:00.000Z",
      "x-ticket": "OPS-119",
    },
    stack: {
      language: ["TypeScript"],
      runtime: [],
      framework: [],
      database: [],
      infrastructure: [],
      "x-reviewed-by": "platform-team",
    },
    nodes: [
      {
        id: "api",
        kind: "service",
        name: "API",
        summary: "REST",
        tech: "Express",
        provenance: { derived: false, authoredBy: "human", "x-reviewer": "sam" },
        "x-sla": "99.9%",
        "x-runbook": "https://example.com/runbook",
      },
    ],
    edges: [
      {
        id: "calls:web->api",
        from: "api",
        to: "api",
        kind: "calls",
        label: "HTTP/REST",
        provenance: {
          derived: true,
          rule: "call-graph",
          evidence: ["src/web/api.ts:12"],
          "x-tool": "scanner/1.2",
        },
        "x-contract": "openapi/v2",
      },
    ],
    decisions: [
      {
        id: "dec-001",
        topic: "Store",
        decision: "SQLite",
        rationale: "single file",
        alternatives: [{ name: "Postgres", whyNot: "operational cost", "x-scored": 3 }],
        timestamp: "2026-05-09T00:00:00.000Z",
        subjects: [{ kind: "node", ref: "api", "x-why": "created it" }],
        "x-status": "ratified",
      },
    ],
    dataFlows: [{ name: "login", steps: [{ actor: "web", action: "submits" }] }],
    history: [
      {
        timestamp: "2026-05-09T00:00:00.000Z",
        action: "initial_scaffold",
        summary: "created",
        "x-agent-version": "0.2.1",
      },
    ],
  };
}

describe("unknown-key preservation — the precondition", () => {
  it("is defaultless, so parsing materialises nothing", () => {
    // If this ever fails, `looseObject` has started writing schema defaults
    // into the user's document, which is the failure ADR-0006 names and the
    // reason it rejected `.passthrough()` on its own.
    const input = documentWithExtensions();
    const parsed = ArchitectureDocumentV2Schema.parse(input);
    expect(parsed).toEqual(input);
  });

  it("does not invent a key that was never written", () => {
    const minimal = {
      schemaVersion: 2,
      project: {
        name: "x",
        description: "",
        created: "2026-05-09T00:00:00.000Z",
        lastUpdated: "2026-05-09T00:00:00.000Z",
      },
      stack: {
        language: [],
        runtime: [],
        framework: [],
        database: [],
        infrastructure: [],
      },
      nodes: [],
      edges: [],
      decisions: [],
      dataFlows: [],
      history: [],
    };
    const parsed = ArchitectureDocumentV2Schema.parse(minimal);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(minimal).sort());
  });
});

describe("unknown-key preservation — the guarantee", () => {
  it("keeps an unknown key at every level of the document", () => {
    const parsed = ArchitectureDocumentV2Schema.parse(documentWithExtensions());
    const document = parsed as unknown as Record<string, any>;

    expect(document["x-document-level"]).toEqual({ addedBy: "hand", ticket: "OPS-119" });
    expect(document.project["x-ticket"]).toBe("OPS-119");
    expect(document.stack["x-reviewed-by"]).toBe("platform-team");
    expect(document.nodes[0]["x-sla"]).toBe("99.9%");
    expect(document.nodes[0]["x-runbook"]).toBe("https://example.com/runbook");
    expect(document.nodes[0].provenance["x-reviewer"]).toBe("sam");
    expect(document.edges[0]["x-contract"]).toBe("openapi/v2");
    expect(document.edges[0].provenance["x-tool"]).toBe("scanner/1.2");
    expect(document.decisions[0]["x-status"]).toBe("ratified");
    expect(document.decisions[0].alternatives[0]["x-scored"]).toBe(3);
    expect(document.decisions[0].subjects[0]["x-why"]).toBe("created it");
    expect(document.history[0]["x-agent-version"]).toBe("0.2.1");
  });

  it("survives an arbitrary number of read/write cycles byte-for-byte", () => {
    // This is the assertion ADR-0006 regression test E asks for. It is the
    // direct consequence of parse output === input: serialising the parsed
    // document writes exactly the same bytes back.
    let document: unknown = JSON.parse(JSON.stringify(documentWithExtensions()));

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const parsed = ArchitectureDocumentV2Schema.parse(document);
      const roundTripped = JSON.parse(JSON.stringify(parsed));
      expect(roundTripped).toEqual(document);
      document = roundTripped;
    }
  });

  it("survives a validate-then-serialise cycle, which is what writeArchitecture does today", () => {
    // `src/io/architecture-file.ts:89` serialises `validation.data`. For v2
    // that is now lossless, because the parsed object is the document.
    const result = validateGraphDocument(documentWithExtensions());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(JSON.parse(JSON.stringify(result.data))).toEqual(documentWithExtensions());
  });

  it("keeps a v3 field written by a newer arkive, when the reader accepts the version", () => {
    // Forward compatibility falls out for free: a v2 reader that accepts the
    // document does not delete what it does not understand.
    const future = { ...documentWithExtensions(), schemaVersion: 3, "x-v3-only": true };
    const parsed = GraphDocumentSchema.parse(future) as Record<string, unknown>;
    expect(parsed["x-v3-only"]).toBe(true);
  });
});

describe("unknown-key preservation — per-container", () => {
  it("NodeSchema keeps unknown keys", () => {
    const parsed = NodeSchema.parse({
      id: "n",
      kind: "module",
      name: "n",
      summary: "",
      provenance: { derived: false, authoredBy: "agent" },
      "x-anything": [1, 2, 3],
    });
    expect(parsed["x-anything"]).toEqual([1, 2, 3]);
  });

  it("EdgeSchema keeps unknown keys", () => {
    const parsed = EdgeSchema.parse({
      id: "e",
      from: "a",
      to: "b",
      kind: "imports",
      provenance: { derived: false, authoredBy: "agent" },
      "x-latency": { p99: 12 },
    });
    expect(parsed["x-latency"]).toEqual({ p99: 12 });
  });

  it("ProvenanceSchema keeps unknown keys on both branches", () => {
    const derived = ProvenanceSchema.parse({
      derived: true,
      rule: "r",
      evidence: ["a.ts:1"],
      "x-tool-version": 2,
    });
    const authored = ProvenanceSchema.parse({
      derived: false,
      authoredBy: "human",
      "x-tool-version": 2,
    });
    expect(derived["x-tool-version"]).toBe(2);
    expect(authored["x-tool-version"]).toBe(2);
  });
});
