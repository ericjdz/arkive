import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeNode, foldV1ViewOntoGraph } from "../../src/io/v1-authoring.js";
import { readArchitecture, writeArchitecture } from "../../src/io/architecture-file.js";
import { projectServices } from "../../src/io/project.js";
import { createEmptyArchitectureV2 } from "../../src/schema/validate-graph.js";
import { authoredBy, derivedFrom } from "../../src/schema/provenance.js";
import type { ArchitectureDocumentV2, GraphNode } from "../../src/schema/graph.js";

/**
 * ADR-0001:129-137 — `removeNode`, and the fold that now shares it.
 *
 * The transaction used to exist twice: once inline in `foldV1ViewOntoGraph`,
 * and once as a set of array filters in `handleUpdateArchitecture`. Two
 * implementations of "remove a node and record the cascade" is how the recorded
 * cascade — the part ADR-0001 singles out as the improvement over v1's silent
 * one — stops being true on one of the two paths.
 */

function graph(): ArchitectureDocumentV2 {
  return {
    ...createEmptyArchitectureV2("removal", "Removal"),
    nodes: [
      node("module:a", "a"),
      node("module:b", "b"),
      node("module:c", "c"),
    ],
    edges: [
      edge("imports:a->b", "module:a", "module:b", "imports"),
      edge("imports:b->c", "module:b", "module:c", "imports"),
      edge("imports:a->c", "module:a", "module:c", "imports"),
    ],
    decisions: [
      {
        id: "dec-001",
        topic: "t",
        decision: "d",
        rationale: "r",
        alternatives: [{ name: "alt", whyNot: "why" }],
        timestamp: "2026-01-01T00:00:00.000Z",
        subjects: [{ kind: "node", ref: "module:b" }],
      },
    ],
  };
}

const NOW = "2026-02-02T00:00:00.000Z";

describe("removeNode", () => {
  it("tombstones the node, drops its edges, and records the count", () => {
    const before = graph();
    const { graph: after, removed } = removeNode(before, "module:b", NOW);

    expect(removed).toEqual({ id: "module:b", droppedEdges: 2 });
    expect(after.nodes.find((n) => n.id === "module:b")?.deletedAt).toBe(NOW);
    expect(after.edges.map((e) => e.id)).toEqual(["imports:a->c"]);

    const entry = after.history.at(-1);
    expect(entry?.action).toBe("remove_node");
    // ADR-0001:134 is explicit that the old cascade was silent; the count is
    // the whole point of recording it.
    expect(entry?.summary).toContain('"module:b"');
    expect(entry?.summary).toContain("2 edges dropped");
    expect(entry?.summary).toContain("Decisions and their subjects were left untouched");
  });

  it("uses the singular for one edge", () => {
    const before = graph();
    const solo = {
      ...before,
      edges: [edge("imports:a->c", "module:a", "module:c", "imports")],
    };
    const { graph: after } = removeNode(solo, "module:c", NOW);
    expect(after.history.at(-1)?.summary).toContain("1 edge dropped");
  });

  it("leaves every decision and subject untouched", () => {
    // ADR-0001:84-86 — removing a node must not destroy rationale. The subject
    // ref still resolves, to a tombstone, which is what `whyDoesThisExist`
    // reports as `unresolved`.
    const before = graph();
    const { graph: after } = removeNode(before, "module:b", NOW);
    expect(after.decisions).toEqual(before.decisions);
    expect(after.decisions[0].subjects).toEqual([{ kind: "node", ref: "module:b" }]);
  });

  it("is pure — the document it was given is not mutated", () => {
    const before = graph();
    const snapshot = JSON.stringify(before);
    removeNode(before, "module:b", NOW);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("is idempotent: removing a tombstone removes nothing again", () => {
    const once = removeNode(graph(), "module:b", NOW).graph;
    const twice = removeNode(once, "module:b", "2026-03-03T00:00:00.000Z");
    expect(twice.removed).toBeNull();
    // One history entry, not two — a re-removal is not a second removal.
    expect(twice.graph.history.filter((h) => h.action === "remove_node")).toHaveLength(1);
  });

  it("returns `removed: null` for an id that never existed", () => {
    const before = graph();
    const after = removeNode(before, "module:nope", NOW);
    expect(after.removed).toBeNull();
    expect(after.graph).toBe(before);
  });

  it("does not mutate the edges it keeps", () => {
    const { graph: after } = removeNode(graph(), "module:b", NOW);
    expect(after.edges).toHaveLength(1);
    expect(after.edges[0].id).toBe("imports:a->c");
  });
});

describe("foldV1ViewOntoGraph", () => {
  it("records the same cascade through the shared transaction", () => {
    // A v1 removal — the service disappears from the projected `services[]` —
    // is the same event as a v2 `removeNode`, and is now literally the same
    // code.
    const services = [
      { id: "module:a", name: "a", type: "other" as const, technology: "ts", description: "", dependencies: [] },
      { id: "module:b", name: "b", type: "other" as const, technology: "ts", description: "", dependencies: [] },
      { id: "module:c", name: "c", type: "other" as const, technology: "ts", description: "", dependencies: [] },
    ];
    const withLegacy = graph();
    withLegacy.nodes = withLegacy.nodes.map((n) => ({ ...n, legacyType: "other" }));

    const folded = foldV1ViewOntoGraph(withLegacy, services.slice(0, 2), []);

    expect(folded.removals).toEqual([{ id: "module:c", droppedEdges: 2 }]);
    expect(folded.graph.nodes.find((n) => n.id === "module:c")?.deletedAt).toBeTruthy();
    expect(folded.graph.history.at(-1)?.action).toBe("remove_node");
    expect(folded.graph.decisions[0].subjects).toEqual([{ kind: "node", ref: "module:b" }]);
  });
});

describe("removal through the persisted document", () => {
  let tempDir: string;

  it("leaves a migrated document writable with a removed node still addressed", () => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-remove-"));
    try {
      const written = writeArchitecture(tempDir, graph());
      if (!written.success) throw new Error(written.error);

      const read = readArchitecture(tempDir);
      if (!read.success) throw new Error(read.error);

      const removed = removeNode(
        { ...read.data, schemaVersion: 2 } as ArchitectureDocumentV2,
        "module:b",
        NOW
      );

      // The deprecated copy is recomputed, exactly as `readArchitecture` does it.
      // Handing `writeArchitecture` the *stale* projection instead — which still
      // lists a node that has just been tombstoned — revives it, because
      // re-adding a node through the v1 view is how a node comes back. That is
      // why `handleUpdateArchitecture` filters `services` in the same call it
      // removes a node in; the hazard is the whole reason the removal is not
      // done by filtering alone.
      const stale = writeArchitecture(tempDir, removed.graph);
      expect(stale.success).toBe(true);
      const revived = readArchitecture(tempDir);
      if (!revived.success) throw new Error(revived.error);
      expect(revived.data.nodes.find((n) => n.id === "module:b")?.deletedAt).toBeUndefined();

      const persisted = writeArchitecture(tempDir, {
        ...removed.graph,
        services: projectServices(removed.graph),
      });
      // The hard invariant: a document that cannot be written cannot be lost.
      // A decision that explains a removed node must not make the file
      // unwritable.
      expect(persisted.success).toBe(true);

      const after = readArchitecture(tempDir);
      if (!after.success) throw new Error(after.error);
      expect(after.data.decisions).toHaveLength(1);
      expect(after.data.nodes.find((n) => n.id === "module:b")?.deletedAt).toBe(NOW);
      expect(after.data.edges.map((e) => e.id)).toEqual(["imports:a->c"]);
      // And the file on disk is the tombstoned document, not a resurrected one.
      expect(after.data.nodes.length).toBe(3);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not duplicate a derived edge the projection already lists", () => {
    // Found while testing the removal path: a graph-native `imports` edge — one
    // `deriveModules` produced with evidence — was skipped by the fold's
    // satisfaction check because it carries no `legacyEdge`, so the desire went
    // unsatisfied and a *second* edge between the same two nodes was minted on
    // every write carrying a v1 view. `legacyEdge` is permission to delete, not
    // permission to count.
    tempDir = mkdtempSync(join(tmpdir(), "arkive-fold-imports-"));
    try {
      const document = graph();
      const written = writeArchitecture(tempDir, document);
      if (!written.success) throw new Error(written.error);

      const read = readArchitecture(tempDir);
      if (!read.success) throw new Error(read.error);
      const before = read.data.edges.length;

      for (let pass = 0; pass < 3; pass += 1) {
        const again = writeArchitecture(tempDir, read.data);
        expect(again.success).toBe(true);
      }

      const after = readArchitecture(tempDir);
      if (!after.success) throw new Error(after.error);
      expect(after.data.edges).toHaveLength(before);
      expect(after.data.edges.filter((e) => e.from === "module:a" && e.to === "module:c")).toHaveLength(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function node(id: string, name: string): GraphNode {
  return {
    id,
    kind: "module",
    name,
    summary: "",
    provenance: authoredBy("agent"),
  };
}

function edge(id: string, from: string, to: string, kind: "imports") {
  return {
    id,
    from,
    to,
    kind,
    provenance: derivedFrom("ts-js/import-edge", [`src/${from}.ts:1`]),
  };
}