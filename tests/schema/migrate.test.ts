import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  MIGRATIONS,
  MIGRATE_FROM_VERSION,
  MIGRATE_TO_VERSION,
  detectSchemaVersion,
  migrateDocument,
  migrateV1ToV2,
  orphanEdges,
} from "../../src/schema/migrate.js";
import { validateGraphDocument } from "../../src/schema/validate-graph.js";
import { validateArchitecture } from "../../src/schema/validate.js";
import type { Architecture } from "../../src/schema/types.js";

/**
 * `migrate(1) -> 2`. The constraint that shapes everything here is
 * losslessness: `62066bc` destroyed four recorded decisions by writing a new
 * file and leaving the old one alone, and nothing warned (ADR-0006:15-51).
 * A migration that drops what it cannot represent is the same failure with
 * better manners.
 */

const NOW = "2026-05-09T00:00:00.000Z";

function v1(overrides: Partial<Architecture> = {}): Architecture {
  return {
    version: "1.0.0",
    project: {
      name: "chat-app",
      description: "Real-time chat",
      created: NOW,
      lastUpdated: NOW,
    },
    stack: {
      language: ["TypeScript"],
      runtime: ["node"],
      framework: ["Express"],
      database: ["PostgreSQL"],
      infrastructure: [],
    },
    services: [],
    connections: [],
    decisions: [],
    dataFlows: [],
    history: [
      { timestamp: NOW, action: "initial_scaffold", summary: "created" },
    ],
    ...overrides,
  };
}

const populated = v1({
  services: [
    {
      id: "web",
      name: "Web Client",
      type: "frontend",
      technology: "Next.js",
      description: "Server-rendered React app",
      ports: ["3000"],
      dependencies: ["api"],
    },
    {
      id: "api",
      name: "API Server",
      type: "backend",
      technology: "Express",
      description: "REST API",
      dependencies: ["db"],
    },
    {
      id: "db",
      name: "Database",
      type: "database",
      technology: "PostgreSQL",
      description: "Primary data store",
      dependencies: [],
    },
  ],
  connections: [
    { from: "web", to: "api", protocol: "HTTP/REST", description: "API calls" },
    { from: "api", to: "db", protocol: "TCP/SQL", description: "queries" },
  ],
  decisions: [
    {
      id: "dec-001",
      topic: "Database choice",
      decision: "PostgreSQL",
      rationale: "Relational model fits the domain",
      alternatives: [{ name: "MongoDB", whyNot: "Adds modelling complexity" }],
      timestamp: NOW,
      relatedServices: ["db", "api"],
    },
  ],
  dataFlows: [
    {
      name: "Login",
      steps: [
        { actor: "web", action: "submits credentials" },
        { actor: "api", action: "validates" },
      ],
    },
  ],
  history: [
    { timestamp: NOW, action: "initial_scaffold", summary: "created" },
    { timestamp: NOW, action: "add_service", summary: "added api", agent: "codex" },
  ],
});

describe("migrate(1) -> 2 — the transform", () => {
  it("turns each service into a node of kind service and drops the type taxonomy", () => {
    const v2 = migrateV1ToV2(populated);
    expect(v2.schemaVersion).toBe(MIGRATE_TO_VERSION);
    expect(v2.nodes.map((n) => n.id)).toEqual(["web", "api", "db"]);
    expect(v2.nodes.every((n) => n.kind === "service")).toBe(true);
    expect(v2.nodes[0]).toMatchObject({
      name: "Web Client",
      summary: "Server-rendered React app",
      tech: "Next.js",
      ports: ["3000"],
    });
    expect(JSON.stringify(v2)).not.toContain('"frontend"');
    expect(JSON.stringify(v2)).not.toContain('"backend"');
  });

  it("turns each dependency into an imports edge", () => {
    const v2 = migrateV1ToV2(populated);
    const imports = v2.edges.filter((e) => e.kind === "imports");
    expect(imports).toEqual([
      expect.objectContaining({ from: "web", to: "api", kind: "imports" }),
      expect.objectContaining({ from: "api", to: "db", kind: "imports" }),
    ]);
  });

  it("turns each connection into a calls edge, protocol demoted to label", () => {
    const v2 = migrateV1ToV2(populated);
    const calls = v2.edges.filter((e) => e.kind === "calls");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      from: "web",
      to: "api",
      kind: "calls",
      label: "HTTP/REST",
    });
    // ADR-0001:22-31 — protocol was the only place a call was distinguished
    // from a read or a write. v2 keeps the text but stops trusting it.
    expect(v2.edges.some((e) => e.protocol !== undefined)).toBe(false);
  });

  it("marks an edge whose endpoints do not resolve as dangling rather than dropping it", () => {
    const v2 = migrateV1ToV2(
      v1({
        services: [
          {
            id: "api",
            name: "API",
            type: "backend",
            technology: "Express",
            description: "d",
            dependencies: [],
          },
        ],
        connections: [
          { from: "api", to: "ghost", protocol: "HTTP", description: "gone" },
        ],
      })
    );
    expect(v2.edges).toHaveLength(1);
    expect(v2.edges[0].dangling).toBe(true);
    expect(orphanEdges(v2)).toHaveLength(1);
  });

  it("leaves a resolvable connection unmarked", () => {
    const v2 = migrateV1ToV2(populated);
    expect(v2.edges.some((edge) => edge.dangling === true)).toBe(false);
  });

  it("converts relatedServices to subjects and keeps unresolvable refs", () => {
    const v2 = migrateV1ToV2(
      v1({
        decisions: [
          {
            id: "dec-001",
            topic: "t",
            decision: "d",
            rationale: "r",
            alternatives: [{ name: "n", whyNot: "w" }],
            timestamp: NOW,
            relatedServices: ["api", "deleted-service"],
          },
        ],
      })
    );
    expect(v2.decisions[0].subjects).toEqual([
      { kind: "node", ref: "api" },
      { kind: "node", ref: "deleted-service" },
    ]);
  });

  it("carries project, stack, dataFlows and history over unchanged", () => {
    const v2 = migrateV1ToV2(populated);
    expect(v2.project).toEqual(populated.project);
    expect(v2.stack).toEqual(populated.stack);
    expect(v2.dataFlows).toEqual(populated.dataFlows);
    expect(v2.history).toEqual(populated.history);
  });

  it("marks every migrated element as authored, not derived", () => {
    // A migration re-runs no analysis. Claiming `derived: true` with a `rule`
    // would assert that a rule produced something no rule ever saw.
    const v2 = migrateV1ToV2(populated);
    for (const element of [...v2.nodes, ...v2.edges]) {
      expect(element.provenance).toEqual({ derived: false, authoredBy: "agent" });
    }
  });

  it("gives every node a unique id and every edge a unique id", () => {
    const v2 = migrateV1ToV2(
      v1({
        services: [
          {
            id: "a",
            name: "A",
            type: "backend",
            technology: "x",
            description: "",
            dependencies: ["b", "b"],
          },
          {
            id: "b",
            name: "B",
            type: "backend",
            technology: "x",
            description: "",
            dependencies: [],
          },
        ],
        connections: [
          { from: "a", to: "b", protocol: "HTTP", description: "" },
          { from: "a", to: "b", protocol: "HTTP", description: "" },
        ],
      })
    );
    expect(new Set(v2.nodes.map((n) => n.id)).size).toBe(v2.nodes.length);
    expect(new Set(v2.edges.map((e) => e.id)).size).toBe(v2.edges.length);
    // Nothing deduplicated: four relationships in, four edges out.
    expect(v2.edges).toHaveLength(4);
  });
});

describe("migrate(1) -> 2 — losslessness", () => {
  it("keeps every v1 service id as a node id", () => {
    const v2 = migrateV1ToV2(populated);
    const nodeIds = new Set(v2.nodes.map((n) => n.id));
    for (const service of populated.services) {
      expect(nodeIds.has(service.id)).toBe(true);
    }
  });

  it("keeps every v1 decision id and every rejected alternative verbatim", () => {
    const v2 = migrateV1ToV2(populated);
    expect(v2.decisions.map((d) => d.id)).toEqual(populated.decisions.map((d) => d.id));
    expect(v2.decisions[0].alternatives).toEqual(populated.decisions[0].alternatives);
  });

  it("holds the counts ADR-0006 regression test D asserts", () => {
    // decisions / services / connections / dataFlows / history before == after.
    const v2 = migrateV1ToV2(populated);
    expect(v2.decisions).toHaveLength(populated.decisions.length);
    expect(v2.nodes).toHaveLength(populated.services.length);
    expect(v2.edges.filter((e) => e.kind === "calls")).toHaveLength(
      populated.connections.length
    );
    expect(v2.dataFlows).toHaveLength(populated.dataFlows.length);
    expect(v2.history).toHaveLength(populated.history.length);
  });

  it("keeps every relationship in the source document as an edge", () => {
    const v2 = migrateV1ToV2(populated);
    const pairs = new Set(v2.edges.map((e) => `${e.kind}:${e.from}->${e.to}`));
    for (const service of populated.services) {
      for (const dependency of service.dependencies) {
        expect(pairs.has(`imports:${service.id}->${dependency}`)).toBe(true);
      }
    }
    for (const connection of populated.connections) {
      expect(pairs.has(`calls:${connection.from}->${connection.to}`)).toBe(true);
    }
  });

  it("drops no id anywhere in the document", () => {
    const v2 = migrateV1ToV2(populated);
    const before = JSON.stringify(populated);
    for (const service of populated.services) {
      expect(before).toContain(`"${service.id}"`);
      expect(JSON.stringify(v2)).toContain(`"${service.id}"`);
    }
    for (const decision of populated.decisions) {
      expect(JSON.stringify(v2)).toContain(`"${decision.id}"`);
    }
  });

  it("does not mutate its input", () => {
    const snapshot = JSON.stringify(populated);
    migrateV1ToV2(populated);
    expect(JSON.stringify(populated)).toBe(snapshot);
  });

  it("does not share array references with its input", () => {
    const v2 = migrateV1ToV2(populated);
    v2.stack.language.push("Rust");
    v2.dataFlows[0].steps.push({ actor: "x", action: "y" });
    expect(populated.stack.language).toEqual(["TypeScript"]);
    expect(populated.dataFlows[0].steps).toHaveLength(2);
  });
});

describe("migrate(1) -> 2 — the documented edge cases", () => {
  it("migrates a completely empty document", () => {
    const empty = v1();
    empty.history = [];
    const v2 = migrateV1ToV2(empty);
    expect(v2.nodes).toEqual([]);
    expect(v2.edges).toEqual([]);
    expect(v2.decisions).toEqual([]);
    expect(validateGraphDocument(v2).success).toBe(true);
  });

  it("migrates a document with no services at all", () => {
    const v2 = migrateV1ToV2(
      v1({ connections: [{ from: "a", to: "b", protocol: "HTTP", description: "" }] })
    );
    expect(v2.nodes).toEqual([]);
    expect(v2.edges).toHaveLength(1);
    expect(v2.edges[0].dangling).toBe(true);
  });

  it("migrates a document carrying only decisions", () => {
    const v2 = migrateV1ToV2(
      v1({
        decisions: [
          {
            id: "dec-only",
            topic: "t",
            decision: "d",
            rationale: "r",
            alternatives: [{ name: "n", whyNot: "w" }],
            timestamp: NOW,
            relatedServices: [],
          },
        ],
      })
    );
    expect(v2.nodes).toEqual([]);
    expect(v2.decisions).toHaveLength(1);
    expect(v2.decisions[0].subjects).toEqual([]);
  });

  it("produces a document that passes v2 validation", () => {
    const result = validateGraphDocument(migrateV1ToV2(populated));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schemaVersion).toBe(2);
    }
  });

  it("produces a document that validates even when a connection dangles", () => {
    const source = v1({
      services: [
        {
          id: "a",
          name: "A",
          type: "backend",
          technology: "x",
          description: "",
          dependencies: [],
        },
      ],
      connections: [{ from: "a", to: "ghost", protocol: "HTTP", description: "" }],
    });
    const result = validateGraphDocument(migrateV1ToV2(source));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.warnings.map((w) => w.code)).toContain("dangling-edge");
    }
  });
});

describe("migrate(1) -> 2 — purity and idempotence", () => {
  it("is deterministic", () => {
    expect(JSON.stringify(migrateV1ToV2(populated))).toBe(
      JSON.stringify(migrateV1ToV2(populated))
    );
  });

  it("is idempotent at the chain level (ADR-0006 regression test I)", () => {
    const once = migrateDocument(JSON.parse(JSON.stringify(populated)));
    expect(once.success).toBe(true);
    if (!once.success) return;
    const twice = migrateDocument(JSON.parse(JSON.stringify(once.data)));
    expect(twice.success).toBe(true);
    if (!twice.success) return;
    expect(twice.data).toEqual(once.data);
  });

  it("is registered in the migration chain", () => {
    expect(MIGRATIONS[MIGRATE_FROM_VERSION]).toBe(migrateV1ToV2);
  });
});

describe("detectSchemaVersion — the probe", () => {
  it("reads an integer schemaVersion", () => {
    expect(detectSchemaVersion({ schemaVersion: 2 })).toBe(2);
    expect(detectSchemaVersion({ schemaVersion: 7 })).toBe(7);
  });

  it("reads a v1 document two ways, because v1 had two ways to be recognised", () => {
    expect(detectSchemaVersion({ version: "1.0.0", project: {} })).toBe(1);
    expect(detectSchemaVersion({ project: { name: "x" } })).toBe(1);
  });

  it("refuses to guess", () => {
    expect(detectSchemaVersion(null)).toBeNull();
    expect(detectSchemaVersion("2")).toBeNull();
    expect(detectSchemaVersion([])).toBeNull();
    expect(detectSchemaVersion({})).toBeNull();
    expect(detectSchemaVersion({ schemaVersion: "2" })).toBeNull();
    expect(detectSchemaVersion({ schemaVersion: 2.5 })).toBeNull();
  });
});

describe("migrateDocument — the chain", () => {
  it("refuses a document from the future instead of best-effort parsing it", () => {
    const result = migrateDocument({ schemaVersion: 99, project: { name: "x" } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("99");
      expect(result.fromVersion).toBe(99);
    }
  });

  it("refuses a document it cannot classify", () => {
    const result = migrateDocument({ hello: "world" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fromVersion).toBeNull();
    }
  });

  it("passes an already-current document through untouched", () => {
    const current = migrateV1ToV2(populated);
    const result = migrateDocument(current);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(current);
    }
  });

  it("routes a v1 document through validateArchitecture first, unchanged", () => {
    const validated = validateArchitecture(JSON.parse(JSON.stringify(populated)));
    expect(validated.success).toBe(true);
    if (!validated.success) return;
    expect(migrateV1ToV2(validated.data)).toEqual(migrateV1ToV2(populated));
  });
});

/**
 * The real documents, not fixtures built to pass.
 *
 * `architecture.json` at the repo root is the file commit `62066bc` orphaned
 * (ADR-0006:35-48): 7 services, 4 decisions with genuine rejected
 * alternatives, 3 dataFlows. It is the one artifact in this repository that
 * proves a migration preserves something, rather than merely round-tripping a
 * shape. A migration that drops it is the incident, repeated.
 *
 * `arkive/legacy-architecture.json` is the same document, tracked so the fixture
 * under `tests/fixtures/62066bc/` is not the only copy.
 */
const REAL_DOCUMENTS = [
  { path: "arkive/architecture.json", services: 3, decisions: 0 },
  { path: "arkive/legacy-architecture.json", services: 7, decisions: 4 },
  { path: "tests/fixtures/62066bc/legacy-root-architecture.json", services: 7, decisions: 4 },
  { path: "tests/fixtures/62066bc/orphan-arkive-architecture.json", services: 3, decisions: 0 },
];

describe("migrate(1) -> 2 — against the real documents", () => {
  const root = join(__dirname, "..", "..");

  for (const document of REAL_DOCUMENTS) {
    const full = join(root, document.path);
    const available = existsSync(full);

    it(`preserves every id in ${document.path}`, () => {
      if (!available) return;
      const raw = JSON.parse(readFileSync(full, "utf-8")) as Architecture;
      const result = migrateDocument(JSON.parse(readFileSync(full, "utf-8")));

      expect(result.success).toBe(true);
      if (!result.success) return;

      const nodeIds = new Set(result.data.nodes.map((node) => node.id));
      for (const service of raw.services) {
        expect(nodeIds.has(service.id), `service ${service.id} lost`).toBe(true);
      }

      const decisionIds = new Set(result.data.decisions.map((decision) => decision.id));
      for (const decision of raw.decisions) {
        expect(decisionIds.has(decision.id), `decision ${decision.id} lost`).toBe(true);
      }

      expect(result.data.nodes).toHaveLength(document.services);
      expect(result.data.decisions).toHaveLength(document.decisions);
    });

    it(`preserves every rejected alternative in ${document.path}`, () => {
      if (!available) return;
      const raw = JSON.parse(readFileSync(full, "utf-8")) as Architecture;
      const result = migrateDocument(JSON.parse(readFileSync(full, "utf-8")));

      expect(result.success).toBe(true);
      if (!result.success) return;

      // `Alternative.whyNot` is the artifact the product exists to keep
      // (ADR-0002:192-195). Every one, in order, byte-for-byte.
      expect(result.data.decisions.flatMap((d) => d.alternatives)).toEqual(
        raw.decisions.flatMap((d) => d.alternatives)
      );
      expect(result.data.dataFlows).toEqual(raw.dataFlows);
      expect(result.data.history).toEqual(raw.history);
    });

    it(`produces a valid v2 document from ${document.path}`, () => {
      if (!available) return;
      const result = migrateDocument(JSON.parse(readFileSync(full, "utf-8")));
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(validateGraphDocument(result.data).success).toBe(true);
    });
  }
});
