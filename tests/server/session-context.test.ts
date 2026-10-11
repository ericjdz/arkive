import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSessionContext,
  buildSessionContextReport,
  estimateTokens,
  DEFAULT_MAX_TOKENS,
  MAX_HISTORY_RENDERED,
  SESSION_CONTEXT_GRAPH_POINTER,
  SESSION_CONTEXT_DECISIONS_POINTER,
  SESSION_CONTEXT_HISTORY_POINTER,
} from "../../src/server/session-context.js";
import type { SessionContextDocument } from "../../src/server/session-context.js";
import type { EdgeKind, GraphEdge, GraphNode, NodeKind } from "../../src/schema/graph.js";
import { MAX_HISTORY_ENTRIES } from "../../src/io/architecture-file.js";

const AUTHORED = { derived: false, authoredBy: "agent" } as const;
const DERIVED = { derived: true, rule: "module-import-graph", evidence: ["src/index.ts:1"] } as const;

function node(
  id: string,
  kind: NodeKind,
  name: string,
  extra: Partial<GraphNode> = {}
): GraphNode {
  return {
    id,
    kind,
    name,
    summary: `${name} — ${kind}`,
    provenance: kind === "module" ? DERIVED : AUTHORED,
    ...extra,
  } as GraphNode;
}

function edge(
  from: string,
  to: string,
  kind: EdgeKind,
  label?: string
): GraphEdge {
  return {
    id: `${kind}:${from}->${to}`,
    from,
    to,
    kind,
    ...(label ? { label } : {}),
    provenance: kind === "imports" ? DERIVED : AUTHORED,
  } as GraphEdge;
}

const PROJECT = {
  name: "test-project",
  description: "A test project",
  lastUpdated: "2026-05-09T00:00:00.000Z",
};

const STACK = {
  language: ["TypeScript"],
  runtime: ["Node.js"],
  framework: ["Express"],
  database: ["Postgres"],
  infrastructure: [],
};

/** A small, ordinary v2 graph. Every section fits. */
function smallDoc(overrides: Partial<SessionContextDocument> = {}): SessionContextDocument {
  return {
    project: PROJECT,
    stack: STACK,
    nodes: [
      node("api", "service", "API", { tech: "Express", summary: "Main API server" }),
      node("web", "service", "Web", { tech: "React", summary: "SPA frontend" }),
      node("db", "datastore", "Database", { tech: "Postgres", summary: "Primary store" }),
    ],
    edges: [
      edge("web", "api", "calls", "HTTP/REST"),
      edge("api", "db", "reads", "TCP/SQL"),
    ],
    decisions: [
      {
        id: "dec-1",
        topic: "Database",
        decision: "Postgres",
        rationale: "Relational",
        alternatives: [{ name: "Mongo", whyNot: "Not relational" }],
        timestamp: "2026-01-01T00:00:00.000Z",
        subjects: [{ kind: "node", ref: "db" }],
      },
    ],
    history: [
      { timestamp: "2026-01-01T00:00:00.000Z", action: "init", summary: "Project initialized" },
      { timestamp: "2026-05-09T00:00:00.000Z", action: "add_api", summary: "Added API service" },
    ],
    ...overrides,
  };
}

/**
 * 300 nodes, 500 edges — the acceptance fixture.
 *
 * Shaped like a real codebase rather than a uniform grid, because the whole
 * point of the ranking is that the distribution matters: a handful of
 * `datastore` / `endpoint` / `service` nodes at the top and a `module` long
 * tail, which is what `src/io/project.ts` turns into a v1 `services[]` entry
 * per file.
 */
function bigDoc(): SessionContextDocument {
  const nodes: GraphNode[] = [
    node("pg-primary", "datastore", "Postgres Primary", { tech: "Postgres 16", summary: "Primary relational store for every durable record." }),
    node("redis-sessions", "datastore", "Redis Sessions", { tech: "Redis 7", summary: "Session and rate-limit state." }),
    node("blob-store", "datastore", "Blob Store", { tech: "S3", summary: "User uploads and generated artefacts." }),
    node("gw-public", "endpoint", "Public Gateway", { tech: "nginx", summary: "Terminates TLS and routes public traffic." }),
    node("gw-admin", "endpoint", "Admin Gateway", { tech: "nginx", summary: "Internal admin traffic. Not public." }),
    node("ep-webhooks", "endpoint", "Webhook Receiver", { tech: "Express", summary: "Inbound third-party webhooks." }),
    node("svc-api", "service", "API Service", { tech: "Express", summary: "The public HTTP API." }),
    node("svc-auth", "service", "Auth Service", { tech: "Express", summary: "Sessions, tokens and billing identity." }),
    node("svc-worker", "service", "Background Worker", { tech: "BullMQ", summary: "Async jobs and scheduled work." }),
    node("ext-stripe", "external", "Stripe", { tech: "stripe-node", summary: "Payments." }),
    node("ext-github", "external", "GitHub", { tech: "octokit", summary: "Release automation." }),
    node("ds-user", "datastructure", "UserRecord", { tech: "zod", summary: "Row shape for a user." }),
    node("ds-order", "datastructure", "OrderRecord", { tech: "zod", summary: "Row shape for an order." }),
  ];

  const MODULE_COUNT = 300 - nodes.length;
  for (let i = 0; i < MODULE_COUNT; i++) {
    const id = `mod-${String(i).padStart(3, "0")}`;
    nodes.push(
      node(id, "module", id, { summary: "", path: `src/features/${id}.ts` })
    );
  }

  const edges: GraphEdge[] = [];
  // Data and control flow first — the edges a session actually needs.
  edges.push(
    edge("gw-public", "svc-api", "calls", "HTTP"),
    edge("gw-public", "gw-admin", "calls", "HTTP"),
    edge("gw-admin", "svc-auth", "calls", "HTTP"),
    edge("ep-webhooks", "svc-worker", "calls", "HTTP"),
    edge("svc-api", "pg-primary", "reads", "SQL"),
    edge("svc-api", "pg-primary", "writes", "SQL"),
    edge("svc-api", "redis-sessions", "reads", "RESP"),
    edge("svc-auth", "pg-primary", "reads", "SQL"),
    edge("svc-auth", "redis-sessions", "writes", "RESP"),
    edge("svc-auth", "ext-stripe", "calls", "HTTPS"),
    edge("svc-worker", "ext-github", "calls", "HTTPS"),
    edge("svc-worker", "pg-primary", "writes", "SQL"),
    edge("svc-worker", "blob-store", "writes", "HTTP"),
    edge("svc-api", "ds-user", "derives_from"),
    edge("svc-api", "ds-order", "derives_from")
  );
  // Then the import long tail: one edge per module into the next, plus a few
  // into the services, which is what a real import graph looks like.
  for (let i = 0; i < MODULE_COUNT - 1; i++) {
    edges.push(
      edge(`mod-${String(i).padStart(3, "0")}`, `mod-${String(i + 1).padStart(3, "0")}`, "imports")
    );
  }
  let extra = 0;
  while (edges.length < 500) {
    const i = extra++;
    const from = `mod-${String(i % MODULE_COUNT).padStart(3, "0")}`;
    const to =
      i % 3 === 0
        ? "svc-api"
        : `mod-${String((i + 7) % MODULE_COUNT).padStart(3, "0")}`;
    edges.push(edge(from, to, "imports"));
  }
  edges.length = 500;

  const decisions = Array.from({ length: 12 }, (_, i) => ({
    id: `dec-${i}`,
    topic: `Decision topic number ${i} about a structural choice`,
    decision: `Chose approach ${i} over ${i + 1} because of reasons that are recorded in full elsewhere`,
    rationale: "Rationale that does not belong in a session summary.",
    alternatives: [{ name: `alt-${i}`, whyNot: "because" }],
    timestamp: "2026-01-01T00:00:00.000Z",
    // `kind: "node" as const` keeps the literal union from widening to
    // `string`, which is what the document schema requires. `as const` on the
    // array itself would make it readonly, which the schema also rejects.
    subjects: [{ kind: "node" as const, ref: "svc-api" }],
  }));

  const history = Array.from({ length: 40 }, (_, i) => ({
    timestamp: `2026-0${(i % 9) + 1}-01T00:00:00.000Z`,
    action: `change_${i}`,
    summary: `Structural change ${i} recorded in the change log`,
  }));

  return { project: PROJECT, stack: STACK, nodes, edges, decisions, history };
}

describe("buildSessionContext — the budget is a bound, not an adjective", () => {
  it("stays under maxTokens for a 300-node, 500-edge fixture (AC1)", () => {
    const doc = bigDoc();
    expect(doc.nodes).toHaveLength(300);
    expect(doc.edges).toHaveLength(500);

    for (const maxTokens of [200, 400, 800, DEFAULT_MAX_TOKENS, 4000, 20000]) {
      const markdown = buildSessionContext(doc, { maxTokens });
      expect(estimateTokens(markdown)).toBeLessThanOrEqual(maxTokens);
    }
  });

  it("is bounded by the budget rather than by the document — the old defect", () => {
    // The pre-0012 code emitted one line per service regardless of maxTokens,
    // so 300 services cost ~300 lines at any setting. Assert the growth curve
    // is now flat in the document and tracks the budget instead.
    const doc = bigDoc();
    const at2000 = estimateTokens(buildSessionContext(doc, { maxTokens: 2000 }));
    const at4000 = estimateTokens(buildSessionContext(doc, { maxTokens: 4000 }));
    expect(at2000).toBeLessThanOrEqual(2000);
    expect(at4000).toBeLessThanOrEqual(4000);
    // 300 service lines at the old ~20 tokens per line would be ~6000 tokens.
    expect(at2000).toBeLessThan(4000);
    // Doubling the budget buys content, not more than the budget.
    expect(at4000).toBeGreaterThan(at2000);
  });

  it("holds the bound for a degenerate document with absurd field sizes", () => {
    const doc = smallDoc({
      project: { ...PROJECT, description: "x".repeat(200_000) },
      nodes: Array.from({ length: 400 }, (_, i) =>
        node(`n${i}`, "module", `module-${i}`, { summary: "y".repeat(5_000) })
      ),
      edges: Array.from({ length: 400 }, (_, i) => edge(`n${i}`, `n${(i + 1) % 400}`, "imports")),
    });
    const report = buildSessionContextReport(doc, { maxTokens: 2000 });
    expect(report.tokens).toBeLessThanOrEqual(2000);
    expect(estimateTokens(report.markdown)).toBe(report.tokens);
  });

  it("holds the bound for every maxTokens down to 1 (AC1, exhaustive)", () => {
    const doc = bigDoc();
    for (let maxTokens = 1; maxTokens <= 600; maxTokens++) {
      const report = buildSessionContextReport(doc, { maxTokens });
      expect(report.tokens).toBeLessThanOrEqual(maxTokens);
      expect(estimateTokens(report.markdown)).toBe(report.tokens);
    }
  });
});

describe("buildSessionContext — truncation is never silent", () => {
  it("announces partiality in the document itself (AC2)", () => {
    const ctx = buildSessionContext(bigDoc(), { maxTokens: DEFAULT_MAX_TOKENS });

    expect(ctx).toContain("PARTIAL");
    expect(ctx).toMatch(/## Nodes \(\d+ of 300 — ranked, tail omitted\)/);
    expect(ctx).toMatch(/## Edges \(\d+ of 500/);
    expect(ctx).toMatch(/omitted/);
    expect(ctx).toContain("Truncated:");
  });

  it("points at the resources that return the whole thing (AC3)", () => {
    const ctx = buildSessionContext(bigDoc(), { maxTokens: DEFAULT_MAX_TOKENS });
    expect(ctx).toContain(SESSION_CONTEXT_GRAPH_POINTER);
    expect(ctx).toContain(SESSION_CONTEXT_DECISIONS_POINTER);
    expect(ctx).toContain(SESSION_CONTEXT_HISTORY_POINTER);
  });

  it("says so on every truncated section, not just the first", () => {
    const report = buildSessionContextReport(bigDoc(), { maxTokens: 900 });
    const dropped = report.sections.filter((section) => section.truncated);
    expect(dropped.length).toBeGreaterThan(0);
    for (const section of dropped) {
      expect(report.markdown).toContain(`${section.label} ${section.shown}/${section.total}`);
    }
  });

  it("does not claim completeness when nothing was dropped", () => {
    const report = buildSessionContextReport(smallDoc(), { maxTokens: DEFAULT_MAX_TOKENS });
    expect(report.truncated).toBe(false);
    expect(report.markdown).toContain("Nothing was dropped");
    expect(report.markdown).not.toContain("PARTIAL");
  });

  it("a document that fits whole is reported as fitting whole", () => {
    // Proves "PARTIAL" is a measurement rather than a standing disclaimer.
    // `history` is cut to what `MAX_HISTORY_RENDERED` can actually show, since
    // every longer history is partial by construction.
    const doc = bigDoc();
    doc.history = (doc.history ?? []).slice(-3);
    const report = buildSessionContextReport(doc, { maxTokens: 400_000 });
    expect(report.truncated).toBe(false);
    expect(report.sections.find((s) => s.label === "nodes")?.shown).toBe(300);
    expect(report.sections.find((s) => s.label === "edges")?.shown).toBe(500);
    expect(report.markdown).toContain("Nothing was dropped");
  });
});

describe("buildSessionContext — priority ranking (AC4)", () => {
  const ctx = buildSessionContext(bigDoc(), { maxTokens: DEFAULT_MAX_TOKENS });

  it("keeps the high-priority kinds and drops the module tail first", () => {
    // datastore / endpoint / service / external / datastructure all survive.
    expect(ctx).toContain("Postgres Primary");
    expect(ctx).toContain("Redis Sessions");
    expect(ctx).toContain("Public Gateway");
    expect(ctx).toContain("Webhook Receiver");
    expect(ctx).toContain("API Service");
    expect(ctx).toContain("Auth Service");
    expect(ctx).toContain("Stripe");
    // The module long tail is what goes. The fixture's modules run
    // mod-000 … mod-286; the deepest ones are the first to be dropped.
    expect(ctx).not.toContain("src/features/mod-286.ts");
    expect(ctx).not.toContain("src/features/mod-200.ts");
  });

  it("drops modules from the bottom of the ranking, not at random", () => {
    // The ranking is kind, then connectivity. Every surviving module at this
    // budget must outrank every dropped one — checked structurally rather than
    // against a hardcoded id list, so the assertion survives fixture changes.
    const moduleSection = buildSessionContextReport(bigDoc(), { maxTokens: DEFAULT_MAX_TOKENS })
      .sections.find((s) => s.label === "nodes");
    expect(moduleSection?.shown).toBeGreaterThan(13); // more than just the top kinds
    expect(moduleSection?.shown).toBeLessThan(300);

    // More budget buys strictly more of the graph, never less.
    const counts = [600, 1200, 2000, 4000].map(
      (maxTokens) =>
        buildSessionContextReport(bigDoc(), { maxTokens }).sections.find((s) => s.label === "nodes")
          ?.shown ?? 0
    );
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThan(counts[i - 1]);
    }
  });

  it("a tight budget keeps the structural kinds and drops every module", () => {
    const tight = buildSessionContext(bigDoc(), { maxTokens: 520 });
    expect(tight).toContain("Postgres Primary");
    expect(tight).toContain("Public Gateway");
    expect(tight).toContain("API Service");
    expect(tight).not.toContain("src/features/mod-");
  });

  it("within a kind, connectivity decides — a hub module beats a leaf module", () => {
    const doc = smallDoc({
      nodes: [
        node("leaf-a", "module", "Leaf A", { summary: "", path: "src/leaf-a.ts" }),
        node("leaf-b", "module", "Leaf B", { summary: "", path: "src/leaf-b.ts" }),
        node("hub-1", "module", "Hub 1", { summary: "", path: "src/hub-1.ts" }),
        node("hub-2", "module", "Hub 2", { summary: "", path: "src/hub-2.ts" }),
        node("hub-3", "module", "Hub 3", { summary: "", path: "src/hub-3.ts" }),
      ],
      edges: [
        edge("leaf-a", "leaf-b", "imports"),
        edge("hub-1", "hub-2", "imports"),
        edge("hub-2", "hub-3", "imports"),
        edge("hub-1", "hub-3", "imports"),
      ],
    });
    // A budget that fits the heading and about two node lines.
    const text = buildSessionContext(doc, { maxTokens: 170 });
    expect(text).toContain("Hub 1");
    expect(text).not.toContain("Leaf A");
    expect(text).not.toContain("Leaf B");
  });

  it("ranking, not a cap, is what removed them — a large budget keeps every module", () => {
    const generous = buildSessionContext(bigDoc(), { maxTokens: 400_000 });
    expect(generous).toContain("src/features/mod-286.ts");
    expect(generous).toContain("src/features/mod-000.ts");
  });

  it("orders by kind before connectivity", () => {
    const clean = smallDoc({
      nodes: [
        node("hub-mod", "module", "Hub Module"),
        node("hub-mod-2", "module", "Second Hub Module"),
        node("hub-mod-3", "module", "Third Hub Module"),
        node("iso-ds", "datastore", "Isolated Datastore"),
      ],
      edges: [
        edge("hub-mod", "hub-mod-2", "imports"),
        edge("hub-mod-2", "hub-mod-3", "imports"),
        edge("hub-mod", "hub-mod-3", "imports"),
      ],
    });
    const text = buildSessionContext(clean, { maxTokens: 220 });
    expect(text.indexOf("Isolated Datastore")).toBeLessThan(text.indexOf("Hub Module"));
  });

  it("prefers edges whose endpoints survived the node cut, and data flow over imports", () => {
    const report = buildSessionContextReport(bigDoc(), { maxTokens: 1400 });
    const nodeSection = report.sections.find((s) => s.label === "nodes");
    const edgeSection = report.sections.find((s) => s.label === "edges");
    expect(nodeSection?.shown).toBeGreaterThan(0);
    expect(edgeSection?.shown).toBeGreaterThan(0);

    const edgesText = report.markdown.slice(
      report.markdown.indexOf("## Edges"),
      report.markdown.indexOf("## Decisions")
    );
    // Every reads/writes/calls/derives_from edge outranks every import edge.
    expect(edgesText).toContain("API Service → Postgres Primary (reads · SQL)");
    expect(edgesText.indexOf("(reads")).toBeLessThan(edgesText.indexOf("(imports)"));
    expect(edgesText.indexOf("(calls")).toBeLessThan(edgesText.indexOf("(imports)"));
    expect(edgesText.indexOf("(derives_from)")).toBeLessThan(edgesText.indexOf("(imports)"));
    // And the module-to-module import chain — the true long tail — is gone.
    expect(edgesText).not.toContain("mod-000 → mod-001");
  });
});

describe("buildSessionContext — history is bounded (AC5)", () => {
  it("renders at most MAX_HISTORY_RENDERED entries regardless of history length", () => {
    const doc = smallDoc({
      history: Array.from({ length: 200 }, (_, i) => ({
        timestamp: "2026-01-01T00:00:00.000Z",
        action: `a${i}`,
        summary: `entry-${i}`,
      })),
    });
    const report = buildSessionContextReport(doc, { maxTokens: DEFAULT_MAX_TOKENS });
    const history = report.sections.find((s) => s.label === "history");
    // `total` is the document's whole `history[]`, not the rendered slice —
    // otherwise `## Recent Changes (5)` reads as complete when 195 are not.
    expect(history?.total).toBe(200);
    expect(history?.shown).toBe(MAX_HISTORY_RENDERED);
    expect(history?.truncated).toBe(true);
    expect(report.markdown).toContain(`## Recent Changes (${MAX_HISTORY_RENDERED} of 200`);
    // The newest survive, the oldest are gone.
    expect(report.markdown).toContain("entry-199");
    expect(report.markdown).not.toContain("entry-0.");
  });

  it("reports a slice that fits as still partial — 40 entries, 5 rendered", () => {
    // The default fixture has 40 history entries and at most 5 can be shown.
    // Whichever of the five actually fit the budget, the section still reports
    // `shown/40` and the closing block lists `history` among the truncated
    // sections — because completeness is a claim about the document, not about
    // whether the allocator ran out of room.
    const report = buildSessionContextReport(bigDoc(), { maxTokens: DEFAULT_MAX_TOKENS });
    const history = report.sections.find((s) => s.label === "history");
    expect(history?.total).toBe(40);
    expect(history?.shown).toBeLessThanOrEqual(MAX_HISTORY_RENDERED);
    expect(history?.shown).toBeGreaterThan(0);
    expect(history?.truncated).toBe(true);
    expect(report.markdown).toContain(`## Recent Changes (${history?.shown} of 40`);
    expect(report.markdown).toContain(`history ${history?.shown}/40`);
  });

  it("names the document cap and where the archive actually lives", () => {
    const doc = smallDoc({
      history: Array.from({ length: MAX_HISTORY_ENTRIES + 10 }, (_, i) => ({
        timestamp: "2026-01-01T00:00:00.000Z",
        action: `a${i}`,
        summary: `entry-${i}`,
      })),
    });
    const ctx = buildSessionContext(doc, { maxTokens: DEFAULT_MAX_TOKENS });
    expect(ctx).toContain(`capped at ${MAX_HISTORY_ENTRIES}`);
    expect(ctx).toContain("arkive/history/");
  });

  it("surfaces the sticky historyTruncated flag", () => {
    const ctx = buildSessionContext(smallDoc({ historyTruncated: true }));
    expect(ctx).toContain(`capped at ${MAX_HISTORY_ENTRIES}`);
  });

  it("never reads the snapshot archive off disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "arkive-session-context-"));
    const marker = "SNAPSHOT-STATE-MUST-NOT-APPEAR";
    try {
      const historyDir = join(dir, "arkive", "history");
      mkdirSync(historyDir, { recursive: true });
      writeFileSync(
        join(historyDir, "2026-01-01T00-00-00-000Z--abc.json"),
        JSON.stringify({ marker, history: [] }),
        "utf-8"
      );

      const ctx = buildSessionContext(smallDoc());
      expect(ctx).not.toContain(marker);
      expect(ctx).not.toContain("arkive/history/2026");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildSessionContext — measured, not adjectival (AC6)", () => {
  it("reports per-section tokens that sum exactly to the total", () => {
    const report = buildSessionContextReport(bigDoc(), { maxTokens: DEFAULT_MAX_TOKENS });
    const sum = report.sections.reduce((acc, section) => acc + section.tokens, 0);
    expect(sum).toBe(report.tokens);
    expect(report.tokens).toBe(estimateTokens(report.markdown));
    expect(report.tokens).toBeLessThanOrEqual(report.maxTokens);
  });

  it("prints the per-section measurement into the document", () => {
    const report = buildSessionContextReport(bigDoc(), { maxTokens: DEFAULT_MAX_TOKENS });
    expect(report.markdown).toMatch(/tokens per section: header \d+ · stack \d+ · nodes \d+/);
    const nodes = report.sections.find((s) => s.label === "nodes");
    expect(report.markdown).toContain(`nodes ${nodes?.tokens}`);
  });

  it("names every section that carries content", () => {
    const report = buildSessionContextReport(smallDoc(), { maxTokens: DEFAULT_MAX_TOKENS });
    expect(report.sections.map((s) => s.label)).toEqual([
      "header",
      "stack",
      "nodes",
      "edges",
      "decisions",
      "history",
      "budget",
    ]);
  });
});

describe("buildSessionContext — behaviour preserved", () => {
  it("returns a compact markdown summary", () => {
    const ctx = buildSessionContext(smallDoc());
    expect(ctx).toContain("test-project");
    expect(ctx).toContain("TypeScript");
    expect(ctx).toContain("API");
    expect(ctx).toContain("Web → API");
    expect(ctx).toContain("Database");
    // Rationale and data-flow steps stay out; they are a lookup, not a load.
    expect(ctx).not.toContain("Relational");
  });

  it("links decisions to the nodes they explain", () => {
    const ctx = buildSessionContext(smallDoc());
    expect(ctx).toContain("**Database** — Postgres");
    expect(ctx).toContain("[nodes: Database]");
  });

  it("excludes tombstoned nodes", () => {
    const ctx = buildSessionContext(
      smallDoc({
        nodes: [
          node("api", "service", "API"),
          node("gone", "service", "Deleted Service", { deletedAt: "2026-01-01T00:00:00.000Z" }),
        ],
      })
    );
    expect(ctx).toContain("API");
    expect(ctx).not.toContain("Deleted Service");
  });

  it("marks dangling edges rather than dropping them", () => {
    const ctx = buildSessionContext(
      smallDoc({
        edges: [{ ...edge("api", "vanished", "calls", "HTTP"), dangling: true }],
      })
    );
    expect(ctx).toContain("⚠ endpoint unresolved");
  });

  it("handles an empty architecture gracefully", () => {
    const report = buildSessionContextReport({
      project: PROJECT,
      stack: {},
      nodes: [],
      edges: [],
      decisions: [],
      history: [],
    });
    expect(report.markdown).toContain("test-project");
    expect(report.markdown).toContain("Nothing was dropped");
    expect(report.sections.map((s) => s.label)).toEqual(["header", "budget"]);
  });

  it("renders a pre-0004 document through the v1 view instead of an empty graph", () => {
    const ctx = buildSessionContext({
      project: PROJECT,
      stack: STACK,
      services: [
        { id: "api", name: "API", type: "backend", technology: "Express", description: "Main API" },
        { id: "db", name: "Database", type: "database", technology: "Postgres", description: "Store" },
      ],
      connections: [{ from: "api", to: "db", protocol: "TCP" }],
    });
    expect(ctx).toContain("**API** (service · Express)");
    expect(ctx).toContain("**Database** (datastore · Postgres)");
    expect(ctx).toContain("API → Database");
  });

  it("is deterministic — the same document produces the same summary", () => {
    const doc = bigDoc();
    expect(buildSessionContext(doc, { maxTokens: 900 })).toBe(
      buildSessionContext(doc, { maxTokens: 900 })
    );
  });
});