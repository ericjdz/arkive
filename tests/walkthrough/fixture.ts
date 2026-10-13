import type { GraphSlice } from "../../src/io/decisions.js";

/**
 * Hand-built fixture graph for the walkthrough engine (issue 0009).
 *
 * Shape, deliberately:
 * - 2 services (svc-api with path src/api, svc-worker with path src/worker)
 * - 1 datastore (db-main), 1 datastructure (ds-order), 1 endpoint, 1 external
 * - 5 modules, one of them tombstoned (mod-old)
 * - 1 decision with a reasoned rejection (d-boundary), 1 observation
 *   (d-edge: whitespace-only whyNot), 1 decision on a tombstone (d-tomb)
 */
export function buildFixtureGraph(): GraphSlice {
  const derived = (rule: string, evidence: string[]) =>
    ({ derived: true as const, rule, evidence });
  const authoredBy = (by: "agent" | "human", reviewedAt?: string) =>
    reviewedAt === undefined
      ? { derived: false as const, authoredBy: by }
      : { derived: false as const, authoredBy: by, reviewedAt };

  return {
    nodes: [
      {
        id: "svc-api",
        kind: "service",
        name: "API",
        summary: "Serves HTTP requests.",
        path: "src/api",
        provenance: authoredBy("agent", "2026-03-01T00:00:00.000Z"),
      },
      {
        id: "svc-worker",
        kind: "service",
        name: "Worker",
        summary: "Processes background jobs.",
        path: "src/worker",
        provenance: authoredBy("human", "2026-03-02T00:00:00.000Z"),
      },
      {
        id: "db-main",
        kind: "datastore",
        name: "MainDB",
        summary: "Primary relational store.",
        provenance: authoredBy("agent"),
      },
      {
        id: "ds-order",
        kind: "datastructure",
        name: "Order",
        summary: "Order record.",
        provenance: derived("shape-scan", ["src/api/handler.ts:12"]),
      },
      {
        id: "mod-routes",
        kind: "module",
        name: "routes",
        summary: "HTTP route table.",
        path: "src/api/routes.ts",
        provenance: derived("import-scan", ["src/api/routes.ts:1"]),
      },
      {
        id: "mod-handler",
        kind: "module",
        name: "handler",
        summary: "Handles order creation.",
        path: "src/api/handler.ts",
        provenance: derived("import-scan", ["src/api/handler.ts:1"]),
      },
      {
        id: "mod-job",
        kind: "module",
        name: "job",
        summary: "Runs background jobs.",
        path: "src/worker/job.ts",
        provenance: derived("import-scan", ["src/worker/job.ts:1"]),
      },
      {
        id: "mod-util",
        kind: "module",
        name: "util",
        summary: "Worker helpers.",
        path: "src/worker/util.ts",
        provenance: derived("import-scan", ["src/worker/util.ts:1"]),
      },
      {
        id: "ep-order",
        kind: "endpoint",
        name: "POST /orders",
        summary: "Creates an order.",
        provenance: authoredBy("agent", "2026-03-03T00:00:00.000Z"),
      },
      {
        id: "ext-stripe",
        kind: "external",
        name: "Stripe",
        summary: "Payments provider.",
        provenance: derived("dep-scan", ["package.json:1"]),
      },
      {
        id: "mod-old",
        kind: "module",
        name: "legacy",
        summary: "Removed handler.",
        path: "src/api/legacy.ts",
        deletedAt: "2026-01-01T00:00:00.000Z",
        provenance: derived("import-scan", ["src/api/legacy.ts:1"]),
      },
    ],
    edges: [
      {
        id: "e-ep-call",
        from: "ep-order",
        to: "mod-handler",
        kind: "calls",
        provenance: derived("call-scan", ["src/api/handler.ts:20"]),
      },
      {
        id: "e-routes-call",
        from: "mod-routes",
        to: "mod-handler",
        kind: "calls",
        provenance: derived("call-scan", ["src/api/routes.ts:8"]),
      },
      {
        id: "e-routes-imp",
        from: "mod-routes",
        to: "mod-handler",
        kind: "imports",
        provenance: derived("import-scan", ["src/api/routes.ts:2"]),
      },
      {
        id: "e-handler-write",
        from: "mod-handler",
        to: "ds-order",
        kind: "writes",
        provenance: derived("shape-scan", ["src/api/handler.ts:30"]),
      },
      {
        id: "e-handler-shape",
        from: "mod-handler",
        to: "ds-order",
        kind: "derives_from",
        provenance: derived("shape-scan", ["src/api/handler.ts:12"]),
      },
      {
        id: "e-job-read",
        from: "mod-job",
        to: "ds-order",
        kind: "reads",
        provenance: derived("shape-scan", ["src/worker/job.ts:15"]),
      },
      {
        id: "e-job-write",
        from: "mod-job",
        to: "db-main",
        kind: "writes",
        provenance: derived("shape-scan", ["src/worker/job.ts:40"]),
      },
      {
        id: "e-handler-util",
        from: "mod-handler",
        to: "mod-util",
        kind: "imports",
        provenance: derived("import-scan", ["src/api/handler.ts:3"]),
      },
      {
        id: "e-api-worker",
        from: "svc-api",
        to: "svc-worker",
        kind: "calls",
        provenance: authoredBy("human", "2026-03-02T00:00:00.000Z"),
      },
      {
        id: "e-job-stripe",
        from: "mod-job",
        to: "ext-stripe",
        kind: "calls",
        provenance: derived("call-scan", ["src/worker/job.ts:50"]),
      },
    ],
    decisions: [
      {
        id: "d-boundary",
        topic: "Split API and worker",
        decision: "Run API and worker as separate services.",
        rationale: "Independent deploys and scaling.",
        alternatives: [{ name: "Monolith", whyNot: "Couples deploys and scaling." }],
        timestamp: "2026-02-01T00:00:00.000Z",
        subjects: [{ kind: "node", ref: "svc-api" }],
      },
      {
        id: "d-edge",
        topic: "Handler writes Order directly",
        decision: "Write the Order record inline in the handler.",
        rationale: "No queue available yet.",
        // Whitespace-only whyNot: passes the schema's min(1) but carries no
        // reason, so this record is an observation, not a decision.
        alternatives: [{ name: "Via queue", whyNot: " " }],
        timestamp: "2026-02-02T00:00:00.000Z",
        subjects: [{ kind: "edge", ref: "e-handler-write" }],
      },
      {
        id: "d-tomb",
        topic: "Remove legacy handler",
        decision: "Delete the legacy handler module.",
        rationale: "Superseded by the current handler.",
        alternatives: [{ name: "Keep legacy", whyNot: "Unmaintained and untested." }],
        timestamp: "2026-01-02T00:00:00.000Z",
        subjects: [{ kind: "node", ref: "mod-old" }],
      },
    ],
  };
}

/** Every `path` value in the graph — the set system level must not expose. */
export function allPaths(graph: GraphSlice): string[] {
  return graph.nodes
    .map((node) => node.path)
    .filter((path): path is string => path !== undefined);
}
