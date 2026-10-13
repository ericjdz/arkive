import { describe, it, expect } from "vitest";
import {
  computeLayeredLayout,
  edgePath,
  LAYOUT,
  type HtmlExportGraph,
} from "../../src/export/html.js";

/**
 * Layout is computed in the generator, not the browser (ADR-0004:129-132),
 * so positions are assertable as pure values. This fixture is fixed: any
 * drift in coordinates fails loudly rather than rendering silently wrong.
 */
export const LAYOUT_FIXTURE: HtmlExportGraph = {
  project: { name: "layout-fixture", description: "" },
  nodes: [
    {
      id: "db",
      kind: "datastore",
      name: "Postgres",
      summary: "Persistent storage.",
      provenance: { derived: false, authoredBy: "human" },
    },
    {
      id: "api",
      kind: "service",
      name: "API",
      summary: "REST API.",
      provenance: { derived: true, rule: "test/rule", evidence: ["src/api.ts:1"] },
    },
    {
      id: "web",
      kind: "module",
      name: "Web client",
      summary: "UI.",
      path: "src/web.ts",
      provenance: { derived: true, rule: "test/rule", evidence: ["src/web.ts:1"] },
    },
    {
      id: "user-shape",
      kind: "datastructure",
      name: "User",
      summary: "User row.",
      path: "src/user.ts",
      provenance: { derived: true, rule: "test/rule", evidence: ["src/user.ts:3"] },
    },
  ],
  edges: [
    {
      id: "e-api-calls-db",
      from: "api",
      to: "db",
      kind: "calls",
      provenance: { derived: false, authoredBy: "agent" },
    },
    {
      id: "e-api-writes-user",
      from: "api",
      to: "user-shape",
      kind: "writes",
      provenance: { derived: false, authoredBy: "agent" },
    },
    {
      id: "e-web-calls-api",
      from: "web",
      to: "api",
      kind: "calls",
      provenance: { derived: false, authoredBy: "agent" },
    },
    {
      id: "e-web-reads-user",
      from: "web",
      to: "user-shape",
      kind: "reads",
      provenance: { derived: false, authoredBy: "agent" },
    },
  ],
  decisions: [],
};

describe("computeLayeredLayout", () => {
  it("places depth by dependency distance with node-id order in each layer", () => {
    const placed = computeLayeredLayout(LAYOUT_FIXTURE.nodes, LAYOUT_FIXTURE.edges);
    const at = (id: string) => placed.get(id)!;

    // web depends on nothing stored: depth 0. api is called by web: depth 1.
    // db and user-shape are downstream of api: depth 2, ordered by id.
    expect(at("web").depth).toBe(0);
    expect(at("api").depth).toBe(1);
    expect(at("db").depth).toBe(2);
    expect(at("user-shape").depth).toBe(2);

    const col = (depth: number) => LAYOUT.pad + depth * (LAYOUT.nodeWidth + LAYOUT.gapX);
    expect(at("web").x).toBe(col(0));
    expect(at("api").x).toBe(col(1));
    expect(at("db").x).toBe(col(2));
    expect(at("user-shape").x).toBe(col(2));

    // Within layer 2, "db" < "user-shape" by id, so db sits above.
    const row = (index: number) => LAYOUT.pad + index * (LAYOUT.nodeHeight + LAYOUT.gapY);
    expect(at("db").y).toBe(row(0));
    expect(at("user-shape").y).toBe(row(1));
    expect(at("web").y).toBe(row(0));
    expect(at("api").y).toBe(row(0));
  });

  it("emits absolute coordinates and deterministic SVG edge paths", () => {
    const placed = computeLayeredLayout(LAYOUT_FIXTURE.nodes, LAYOUT_FIXTURE.edges);
    const d = edgePath(placed.get("web")!, placed.get("api")!);
    // web right edge (40, 40+32) to api left edge (360, 40+32): symmetric curve.
    expect(d).toBe("M 240 72 C 300 72, 300 72, 360 72");
  });

  it("is byte-stable across runs and input orderings", () => {
    const first = computeLayeredLayout(LAYOUT_FIXTURE.nodes, LAYOUT_FIXTURE.edges);
    const shuffled = computeLayeredLayout(
      [...LAYOUT_FIXTURE.nodes].reverse(),
      [...LAYOUT_FIXTURE.edges].reverse()
    );
    const serialise = (m: Map<string, { x: number; y: number; depth: number }>) =>
      [...m.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([id, p]) => `${id}:${p.x},${p.y},${p.depth}`)
        .join("|");
    expect(serialise(shuffled)).toBe(serialise(first));
  });

  it("terminates on dependency cycles instead of deepening forever", () => {
    const cyclic = computeLayeredLayout(
      LAYOUT_FIXTURE.nodes,
      [
        ...LAYOUT_FIXTURE.edges,
        {
          id: "e-cycle",
          from: "api",
          to: "web",
          kind: "calls",
          provenance: { derived: false, authoredBy: "agent" },
        },
      ]
    );
    for (const [, p] of cyclic) {
      expect(p.depth).toBeLessThanOrEqual(LAYOUT_FIXTURE.nodes.length);
    }
  });

  it("ignores edges whose endpoints do not resolve", () => {
    const placed = computeLayeredLayout(LAYOUT_FIXTURE.nodes, [
      ...LAYOUT_FIXTURE.edges,
      {
        id: "e-dangling",
        from: "web",
        to: "ghost",
        kind: "calls",
        provenance: { derived: false, authoredBy: "agent" },
      },
    ]);
    expect(placed.get("web")!.depth).toBe(0);
    expect(placed.has("ghost")).toBe(false);
  });
});
