import { describe, it, expect } from "vitest";
import { buildFixtureGraph, allPaths } from "./fixture.js";
import {
  viewAtLevel,
  ascend,
  open,
  SYSTEM_ROOT,
  type WalkLevel,
  type OpenResult,
} from "../../src/walkthrough/index.js";

const LEVELS: WalkLevel[] = ["system", "subsystem", "module"];

/** Collect every object key anywhere in a value, recursively. */
function allKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, into);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      into.add(key);
      allKeys(item, into);
    }
  }
  return into;
}

function mustOpen(result: OpenResult): Extract<OpenResult, { found: true }> {
  expect(result.found).toBe(true);
  if (!result.found) throw new Error("expected open() to resolve");
  return result;
}

describe("levels: every node walkable at all three levels", () => {
  for (const level of LEVELS) {
    it(`reaches every node kind at ${level} level (incl. tombstones)`, () => {
      const graph = buildFixtureGraph();
      const kinds = new Set(graph.nodes.map((node) => node.kind));
      expect(kinds.has("module")).toBe(true);
      expect(kinds.has("service")).toBe(true);
      expect(kinds.has("datastore")).toBe(true);
      expect(kinds.has("external")).toBe(true);
      expect(kinds.has("datastructure")).toBe(true);
      expect(kinds.has("endpoint")).toBe(true);

      for (const node of graph.nodes) {
        const view = mustOpen(viewAtLevel(graph, node.id, level));
        expect(view.level).toBe(level);
        expect(view.subjectKind).toBe("node");
        expect(view.breadcrumb).toEqual([SYSTEM_ROOT, node.id]);
      }
    });
  }

  it("reports tombstoned nodes as not-live at every level, without dropping them", () => {
    const graph = buildFixtureGraph();
    for (const level of LEVELS) {
      const view = mustOpen(viewAtLevel(graph, "mod-old", level));
      if (view.subjectKind !== "node" || view.subject.kind !== "node") {
        throw new Error("expected a node subject");
      }
      expect(view.subject.live).toBe(false);
      expect(view.subject.removedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(view.notes.join("\n")).toMatch(/removed|tombstone/i);
    }
  });

  it("returns found:false for an unknown ref at every level", () => {
    const graph = buildFixtureGraph();
    for (const level of LEVELS) {
      const view = viewAtLevel(graph, "no-such-node", level);
      expect(view.found).toBe(false);
      if (view.found) throw new Error("expected found:false");
      expect(view.notes.length).toBeGreaterThan(0);
    }
  });
});

describe("levels: provenance visible at every level", () => {
  for (const level of LEVELS) {
    it(`carries gate/evidence/caveats on every claim at ${level} level`, () => {
      const graph = buildFixtureGraph();
      for (const node of graph.nodes) {
        const view = mustOpen(viewAtLevel(graph, node.id, level));
        for (const claim of [view.provenance]) {
          expect(["derived", "authored", "unresolved"]).toContain(claim.gate);
          expect(Array.isArray(claim.evidence)).toBe(true);
          expect(Array.isArray(claim.caveats)).toBe(true);
        }
        for (const child of view.children) {
          expect(["derived", "authored", "unresolved"]).toContain(child.provenance.gate);
        }
        for (const decision of view.decisions) {
          expect(["derived", "authored", "unresolved"]).toContain(decision.provenance.gate);
          expect(Array.isArray(decision.provenance.evidence)).toBe(true);
          expect(Array.isArray(decision.provenance.caveats)).toBe(true);
        }
      }
    });
  }

  it("marks derived nodes derived with file:line evidence", () => {
    const graph = buildFixtureGraph();
    const view = mustOpen(viewAtLevel(graph, "mod-handler", "module"));
    expect(view.provenance.gate).toBe("derived");
    expect(view.provenance.evidence).toEqual(["src/api/handler.ts:1"]);
    expect(view.provenance.caveats.length).toBeGreaterThan(0);
  });

  it("marks authored-but-unreviewed nodes with a caveat", () => {
    const graph = buildFixtureGraph();
    const view = mustOpen(viewAtLevel(graph, "db-main", "module"));
    expect(view.provenance.gate).toBe("authored");
    expect(view.provenance.evidence).toEqual([]);
    expect(view.provenance.caveats.length).toBeGreaterThan(0);
  });
});

describe("levels: abstraction honesty", () => {
  it("system level exposes no path key for any node", () => {
    const graph = buildFixtureGraph();
    const paths = allPaths(graph);
    expect(paths.length).toBeGreaterThan(0);
    for (const node of graph.nodes) {
      const view = mustOpen(viewAtLevel(graph, node.id, "system"));
      expect(allKeys(view).has("path")).toBe(false);
      expect(allKeys(view).has("summary")).toBe(false);
    }
  });

  it("module level carries real paths on the subject and its children", () => {
    const graph = buildFixtureGraph();
    const view = mustOpen(viewAtLevel(graph, "svc-api", "module"));
    if (view.subjectKind !== "node" || view.subject.kind !== "node") {
      throw new Error("expected a node subject");
    }
    expect(view.subject.path).toBe("src/api");
    const childPaths = view.children.map((child) => child.path).sort();
    expect(childPaths).toEqual([
      "src/api/handler.ts",
      "src/api/legacy.ts",
      "src/api/routes.ts",
    ]);
  });

  it("subsystem level names modules without exposing paths", () => {
    const graph = buildFixtureGraph();
    const view = mustOpen(viewAtLevel(graph, "svc-api", "subsystem"));
    expect(allKeys(view).has("path")).toBe(false);
    const childIds = view.children.map((child) => child.id).sort();
    expect(childIds).toEqual(["mod-handler", "mod-old", "mod-routes"]);
  });
});

describe("levels: up/down navigation preserves breadcrumb", () => {
  it("open() roots the breadcrumb at the system root", () => {
    const graph = buildFixtureGraph();
    const view = mustOpen(open(graph, "svc-api"));
    expect(view.breadcrumb).toEqual([SYSTEM_ROOT, "svc-api"]);
  });

  it("descending appends and ascending slices without losing place", () => {
    const graph = buildFixtureGraph();
    const top = mustOpen(open(graph, "svc-api"));
    const down = mustOpen(
      open(graph, "mod-handler", { breadcrumb: top.breadcrumb })
    );
    expect(down.breadcrumb).toEqual([SYSTEM_ROOT, "svc-api", "mod-handler"]);

    const up = ascend(graph, down.breadcrumb);
    expect(up.moved).toBe(true);
    if (!up.moved) throw new Error("expected to move up");
    const parent = mustOpen(up.view);
    expect(parent.ref).toBe("svc-api");
    expect(parent.breadcrumb).toEqual([SYSTEM_ROOT, "svc-api"]);

    // Descending again from the restored breadcrumb returns to the same place.
    const again = mustOpen(open(graph, "mod-handler", { breadcrumb: parent.breadcrumb }));
    expect(again.breadcrumb).toEqual(down.breadcrumb);
    expect(again.ref).toBe(down.ref);
  });

  it("ascend at the system root reports moved:false instead of inventing a parent", () => {
    const graph = buildFixtureGraph();
    const up = ascend(graph, [SYSTEM_ROOT]);
    expect(up.moved).toBe(false);
  });
});
