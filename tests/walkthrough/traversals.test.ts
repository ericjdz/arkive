import { describe, it, expect } from "vitest";
import { projectDecidedBy } from "../../src/io/decisions.js";
import { buildFixtureGraph } from "./fixture.js";
import {
  topology,
  open,
  trace,
  traceRequest,
  explainBoundary,
  explainDecision,
  followDataShape,
  type OpenResult,
  type TraceResult,
} from "../../src/walkthrough/index.js";

function mustOpen(result: OpenResult): Extract<OpenResult, { found: true }> {
  expect(result.found).toBe(true);
  if (!result.found) throw new Error("expected open() to resolve");
  return result;
}

describe("topology()", () => {
  it("lists every node and edge with names, kinds, and directions — and no prose", () => {
    const graph = buildFixtureGraph();
    const topo = topology(graph);
    expect(topo.nodes).toHaveLength(graph.nodes.length);
    expect(topo.edges).toHaveLength(graph.edges.length);
    for (const node of topo.nodes) {
      expect(typeof node.id).toBe("string");
      expect(typeof node.kind).toBe("string");
      expect(typeof node.name).toBe("string");
      expect(typeof node.live).toBe("boolean");
    }
    for (const edge of topo.edges) {
      expect(typeof edge.from).toBe("string");
      expect(typeof edge.to).toBe("string");
      expect(typeof edge.kind).toBe("string");
    }
    const serialised = JSON.stringify(topo);
    // No narrative fields (summaries) and no path granularity. Provenance
    // evidence (file:line sites) is trust metadata, not granularity: the spec
    // requires it on every result, so it stays even at system level.
    expect(serialised).not.toContain('"summary"');
    expect(serialised).not.toContain('"path"');
  });

  it("marks tombstones without dropping them, and provenances every entry", () => {
    const graph = buildFixtureGraph();
    const topo = topology(graph);
    const old = topo.nodes.find((node) => node.id === "mod-old");
    expect(old?.live).toBe(false);
    for (const node of topo.nodes) {
      expect(["derived", "authored", "unresolved"]).toContain(node.provenance.gate);
    }
    for (const edge of topo.edges) {
      expect(["derived", "authored", "unresolved"]).toContain(edge.provenance.gate);
    }
  });
});

describe("open()", () => {
  it("groups inbound/outbound edges by kind", () => {
    const graph = buildFixtureGraph();
    const view = mustOpen(open(graph, "mod-handler"));
    expect(view.inbound.calls.map((edge) => edge.id).sort()).toEqual([
      "e-ep-call",
      "e-routes-call",
    ]);
    expect(view.inbound.imports.map((edge) => edge.id)).toEqual(["e-routes-imp"]);
    expect(view.outbound.writes.map((edge) => edge.id)).toEqual(["e-handler-write"]);
    expect(view.outbound.derives_from.map((edge) => edge.id)).toEqual([
      "e-handler-shape",
    ]);
    expect(view.outbound.imports.map((edge) => edge.id)).toEqual(["e-handler-util"]);
  });

  it("lists module children by path containment", () => {
    const graph = buildFixtureGraph();
    const view = mustOpen(open(graph, "svc-api"));
    expect(view.children.map((child) => child.id).sort()).toEqual([
      "mod-handler",
      "mod-old",
      "mod-routes",
    ]);
  });

  it("lists datastructure neighbours within one hop as data shapes", () => {
    const graph = buildFixtureGraph();
    const view = mustOpen(open(graph, "mod-handler"));
    expect(view.dataShapes.map((shape) => shape.id)).toEqual(["ds-order"]);
  });

  it("joins decided_by decisions with the same semantics as projectDecidedBy", () => {
    const graph = buildFixtureGraph();
    const view = mustOpen(open(graph, "svc-api"));
    const expected = projectDecidedBy(graph)
      .filter((edge) => edge.from === "svc-api")
      .map((edge) => edge.to)
      .sort();
    expect(view.decisions.map((decision) => decision.id).sort()).toEqual(expected);
    expect(view.decisions.map((decision) => decision.id)).toEqual(["d-boundary"]);
    const [entry] = view.decisions;
    expect(entry.alternatives).toEqual([
      { name: "Monolith", whyNot: "Couples deploys and scaling." },
    ]);
    expect(entry.observation).toBe(false);
  });

  it("opens edges, joining edge-subject decisions", () => {
    const graph = buildFixtureGraph();
    const view = mustOpen(open(graph, "e-handler-write"));
    expect(view.subjectKind).toBe("edge");
    expect(view.decisions.map((decision) => decision.id)).toEqual(["d-edge"]);
    expect(view.decisions[0].observation).toBe(true);
  });

  it("defaults depth to 1 and clamps it to a maximum of 3", () => {
    const graph = buildFixtureGraph();
    expect(mustOpen(open(graph, "svc-api")).depth).toBe(1);
    expect(mustOpen(open(graph, "svc-api", 99)).depth).toBe(3);
    expect(mustOpen(open(graph, "svc-api", 0)).depth).toBe(1);
    const clamped = mustOpen(open(graph, "svc-api", 99));
    expect(clamped.notes.join("\n")).toMatch(/depth/i);
  });

  it("returns found:false for an unknown ref", () => {
    const graph = buildFixtureGraph();
    const view = open(graph, "no-such-ref");
    expect(view.found).toBe(false);
  });
});

describe("trace()", () => {
  it("finds the shortest directed path, annotated with edge kind per hop", () => {
    const graph = buildFixtureGraph();
    const result = trace(graph, "mod-routes", "ds-order");
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected a path");
    expect(result.nodes.map((node) => node.id)).toEqual([
      "mod-routes",
      "mod-handler",
      "ds-order",
    ]);
    expect(result.hops.map((hop) => hop.kind)).toEqual(["calls", "derives_from"]);
    // Two equal-length routes leave mod-handler (derives_from via
    // e-handler-shape, writes via e-handler-write); the deterministic
    // tie-break is lowest edge id first.
    expect(result.hops.map((hop) => hop.via)).toEqual([
      "e-routes-call",
      "e-handler-shape",
    ]);
    expect(result.hops[0]).toMatchObject({
      from: "mod-routes",
      to: "mod-handler",
      via: "e-routes-call",
    });
    expect(result.edges.map((edge) => edge.id)).toEqual([
      "e-routes-call",
      "e-handler-shape",
    ]);
  });

  it("resolves a zero-hop path from a node to itself", () => {
    const graph = buildFixtureGraph();
    const result = trace(graph, "svc-api", "svc-api");
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected a path");
    expect(result.nodes.map((node) => node.id)).toEqual(["svc-api"]);
    expect(result.hops).toEqual([]);
  });

  it("returns found:false — never an invented path — when no route exists", () => {
    const graph = buildFixtureGraph();
    const result: TraceResult = trace(graph, "db-main", "mod-routes");
    expect(result.found).toBe(false);
    if (result.found) throw new Error("expected no path");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("returns found:false for unknown endpoints", () => {
    const graph = buildFixtureGraph();
    expect(trace(graph, "nope", "ds-order").found).toBe(false);
    expect(trace(graph, "mod-routes", "nope").found).toBe(false);
  });
});

describe("traceRequest()", () => {
  it("traces runtime edges end to end with per-hop actions", () => {
    const graph = buildFixtureGraph();
    const result = traceRequest(graph, "mod-routes", "ds-order");
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected a path");
    expect(result.hops.map((hop) => hop.action)).toEqual(["invoke", "write"]);
    expect(result.runtimeOnly).toBe(true);
  });

  it("ignores structural edges: an imports-only route is not a request path", () => {
    const graph = buildFixtureGraph();
    expect(trace(graph, "mod-handler", "mod-util").found).toBe(true);
    const request = traceRequest(graph, "mod-handler", "mod-util");
    expect(request.found).toBe(false);
  });
});

describe("explainBoundary()", () => {
  it("explains the grouping: children, edges by kind, decisions", () => {
    const graph = buildFixtureGraph();
    const result = explainBoundary(graph, "svc-api");
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected a boundary");
    expect(result.children.map((child) => child.id).sort()).toEqual([
      "mod-handler",
      "mod-old",
      "mod-routes",
    ]);
    expect(result.outboundByKind.calls.map((edge) => edge.id)).toEqual(["e-api-worker"]);
    expect(result.decisions.map((decision) => decision.id)).toEqual(["d-boundary"]);
    expect(result.provenance.gate).toBe("authored");
  });

  it("names the edges that cross the boundary", () => {
    const graph = buildFixtureGraph();
    const result = explainBoundary(graph, "svc-api");
    if (!result.found) throw new Error("expected a boundary");
    const crossing = result.crossingEdges.map((edge) => edge.id).sort();
    // ep-order -> mod-handler enters the subtree; svc-api -> svc-worker leaves it.
    expect(crossing).toContain("e-ep-call");
    expect(crossing).toContain("e-api-worker");
    expect(crossing).not.toContain("e-routes-call");
  });

  it("returns found:false for an unknown ref", () => {
    const graph = buildFixtureGraph();
    expect(explainBoundary(graph, "nope").found).toBe(false);
  });
});

describe("explainDecision()", () => {
  it("reports the decision with its rejected alternatives at a node", () => {
    const graph = buildFixtureGraph();
    const result = explainDecision(graph, "svc-api");
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected claims");
    expect(result.claims).toHaveLength(1);
    const [claim] = result.claims;
    expect(claim.decisionId).toBe("d-boundary");
    expect(claim.rejectedAlternatives).toEqual([
      { name: "Monolith", whyNot: "Couples deploys and scaling." },
    ]);
    expect(claim.observation).toBe(false);
    expect(claim.via).toBe("direct");
    expect(claim.provenance.gate).toBe("authored");
  });

  it("flags — never hides — a decision with no reasoned rejection", () => {
    const graph = buildFixtureGraph();
    const result = explainDecision(graph, "e-handler-write");
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected claims");
    expect(result.claims).toHaveLength(1);
    const [claim] = result.claims;
    expect(claim.alternatives[0].name).toBe("Via queue");
    expect(claim.observation).toBe(true);
    expect(result.summary.observations).toBe(1);
  });

  it("surfaces rationale for a tombstoned node instead of dropping it", () => {
    const graph = buildFixtureGraph();
    const result = explainDecision(graph, "mod-old");
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected claims");
    // d-tomb names mod-old directly; d-boundary names its ancestor svc-api
    // (path containment) and reaches it as an inherited claim. Both survive.
    expect(result.claims.map((claim) => claim.decisionId).sort()).toEqual([
      "d-boundary",
      "d-tomb",
    ]);
    const tomb = result.claims.find((claim) => claim.decisionId === "d-tomb")!;
    expect(tomb.via).toBe("direct");
    expect(tomb.rejectedAlternatives).toEqual([
      { name: "Keep legacy", whyNot: "Unmaintained and untested." },
    ]);
    expect(tomb.observation).toBe(false);
    const inherited = result.claims.find((claim) => claim.decisionId === "d-boundary")!;
    expect(inherited.via).toBe("inherited");
  });

  it("reports zero claims — not zero existence — for a node with no decisions", () => {
    const graph = buildFixtureGraph();
    const result = explainDecision(graph, "ext-stripe");
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected a resolved ref");
    expect(result.claims).toEqual([]);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it("returns found:false for an unknown ref", () => {
    const graph = buildFixtureGraph();
    expect(explainDecision(graph, "nope").found).toBe(false);
  });
});

describe("followDataShape()", () => {
  it("follows a datastructure to its writers, readers, and transformations", () => {
    const graph = buildFixtureGraph();
    const result = followDataShape(graph, "ds-order");
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected the shape");
    expect(result.writers.map((entry) => entry.node.id)).toEqual(["mod-handler"]);
    expect(result.writers[0].edge.id).toBe("e-handler-write");
    expect(result.readers.map((entry) => entry.node.id)).toEqual(["mod-job"]);
    expect(result.transformations.map((entry) => entry.node.id)).toEqual(["mod-handler"]);
    expect(result.lineage).toEqual([]);
    expect(result.provenance.gate).toBe("derived");
    expect(result.provenance.evidence).toEqual(["src/api/handler.ts:12"]);
  });

  it("says so when the ref is not a datastructure, without failing", () => {
    const graph = buildFixtureGraph();
    const result = followDataShape(graph, "svc-api");
    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected a resolved ref");
    expect(result.notes.join("\n")).toMatch(/not a datastructure/i);
  });

  it("returns found:false for an unknown ref", () => {
    const graph = buildFixtureGraph();
    expect(followDataShape(graph, "nope").found).toBe(false);
  });
});
