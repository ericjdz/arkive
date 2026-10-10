import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readArchitecture,
  writeArchitecture,
  architecturePath,
  arkiveDirPath,
  listSnapshots,
} from "../../src/io/architecture-file.js";
import { projectDocument } from "../../src/io/project.js";
import { validateGraphDocument } from "../../src/schema/validate-graph.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/schema/graph.js";
import { detectDrift } from "../../src/analysis/drift.js";
import type { Architecture } from "../../src/schema/types.js";

/**
 * The 62066bc acceptance test.
 *
 * Commit `62066bc` moved the document from `<root>/architecture.json` to
 * `<root>/arkive/architecture.json`. The code path moved; the data did not. A
 * blank scaffold appeared at the new path, the real document — 7 services, 4
 * decisions with genuine rejected alternatives, 3 dataFlows — was orphaned at
 * the old one, and both files existed side by side with nothing warning about
 * it (ADR-0006:15-51).
 *
 * That document is checked into this repository as
 * `arkive/legacy-architecture.json`. It is the one artifact here that proves a
 * migration *preserves* something rather than merely round-tripping a shape: a
 * migration that drops it is the incident, repeated.
 *
 * Issue 0004's acceptance criterion is "the next write persists v2 and the v1
 * fields survive as projections". This is that, on the real file.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const LEGACY = join(REPO_ROOT, "arkive", "legacy-architecture.json");

/** What ADR-0006:37-42 records the orphaned document actually contained. */
const EXPECTED = {
  services: 7,
  decisions: 4,
  dataFlows: 3,
  connections: 6,
  history: 4,
};

describe("regression D — the real 62066bc document survives v1 -> v2 -> read", () => {
  let tempDir: string;
  let v1: {
    services: Array<{ id: string }>;
    connections: Array<{ from: string; to: string; protocol: string }>;
    decisions: Array<{
      id: string;
      topic: string;
      decision: string;
      rationale: string;
      alternatives: Array<{ name: string; whyNot: string }>;
    }>;
    dataFlows: Array<{ name: string; steps: unknown[] }>;
    history: Array<{ timestamp: string; action: string; summary: string }>;
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-62066bc-roundtrip-"));
    mkdirSync(arkiveDirPath(tempDir), { recursive: true });
    v1 = JSON.parse(readFileSync(LEGACY, "utf-8"));
    copyFileSync(LEGACY, architecturePath(tempDir));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("the fixture really is the document from the incident", () => {
    expect(v1.services).toHaveLength(EXPECTED.services);
    expect(v1.decisions).toHaveLength(EXPECTED.decisions);
    expect(v1.dataFlows).toHaveLength(EXPECTED.dataFlows);
    expect(v1.connections).toHaveLength(EXPECTED.connections);
    expect(v1.history).toHaveLength(EXPECTED.history);
  });

  it("read -> write -> read keeps every count", () => {
    const before = readArchitecture(tempDir);
    expect(before.success).toBe(true);
    if (!before.success) return;

    const wrote = writeArchitecture(tempDir, before.data);
    expect(wrote.success).toBe(true);

    const after = readArchitecture(tempDir);
    expect(after.success).toBe(true);
    if (!after.success) return;

    // 7 services, 4 decisions, 3 dataFlows. The acceptance criterion.
    expect(after.data.services).toHaveLength(EXPECTED.services);
    expect(after.data.decisions).toHaveLength(EXPECTED.decisions);
    expect(after.data.dataFlows).toHaveLength(EXPECTED.dataFlows);

    // And the graph agrees with the projection, because the projection is
    // computed from it.
    expect(after.data.nodes).toHaveLength(EXPECTED.services);
    expect(after.data.connections).toHaveLength(EXPECTED.connections);
    // cli(4) + mcp-server(1) + viewer(1) + scanner(1) + learning(1) = 8
    expect(after.data.edges.filter((e) => e.kind === "imports").length).toBe(8);
    expect(after.data.edges.filter((e) => e.kind === "calls").length).toBe(EXPECTED.connections);
  });

  it("every service id survives, in order", () => {
    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(writeArchitecture(tempDir, read.data).success).toBe(true);

    const after = readArchitecture(tempDir);
    expect(after.success).toBe(true);
    if (!after.success) return;
    expect(after.data.services.map((s) => s.id)).toEqual(v1.services.map((s) => s.id));
  });

  it("every rejected alternative survives verbatim — the artifact the product exists to keep", () => {
    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(writeArchitecture(tempDir, read.data).success).toBe(true);

    const after = readArchitecture(tempDir);
    expect(after.success).toBe(true);
    if (!after.success) return;

    expect(after.data.decisions.flatMap((d) => d.alternatives)).toEqual(
      v1.decisions.flatMap((d) => d.alternatives)
    );
    // Specifically `dec-003`, which records the React 18/19 duplicate-React bug
    // and why pinning to 18 would not have fixed it (ADR-0006:42-47).
    const dec003 = after.data.decisions.find((d) => d.id === "dec-003");
    expect(dec003?.alternatives[0].whyNot).toContain("duplicate React instances");
  });

  it("every decision's rationale and history entry survives unchanged", () => {
    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(writeArchitecture(tempDir, read.data).success).toBe(true);

    const after = readArchitecture(tempDir);
    expect(after.success).toBe(true);
    if (!after.success) return;

    expect(after.data.decisions.map((d) => [d.id, d.topic, d.decision, d.rationale])).toEqual(
      v1.decisions.map((d) => [d.id, d.topic, d.decision, d.rationale])
    );
    expect(after.data.dataFlows).toEqual(v1.dataFlows);
    expect(after.data.history.map((h) => [h.timestamp, h.action, h.summary])).toEqual(
      v1.history.map((h) => [h.timestamp, h.action, h.summary])
    );
  });

  it("decision subjects point at nodes that exist", () => {
    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;

    const ids = new Set(read.data.nodes.map((n) => n.id));
    for (const decision of read.data.decisions) {
      for (const subject of decision.subjects) {
        if (subject.kind !== "node") continue;
        expect(ids.has(subject.ref), `${decision.id} -> ${subject.ref}`).toBe(true);
      }
    }
  });

  it("the v2 document on disk validates, and reports no drift of its own", () => {
    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(writeArchitecture(tempDir, read.data).success).toBe(true);

    const onDisk = JSON.parse(readFileSync(architecturePath(tempDir), "utf-8"));
    expect(onDisk.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(validateGraphDocument(onDisk).success).toBe(true);

    const after = readArchitecture(tempDir);
    expect(after.success).toBe(true);
    if (!after.success) return;
    expect(after.data.warnings ?? []).toEqual([]);
  });

  it("is a fixed point: a second write changes nothing but the timestamp", () => {
    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(writeArchitecture(tempDir, read.data).success).toBe(true);

    const first = JSON.parse(readFileSync(architecturePath(tempDir), "utf-8"));
    const second = readArchitecture(tempDir);
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(writeArchitecture(tempDir, second.data).success).toBe(true);

    const after = JSON.parse(readFileSync(architecturePath(tempDir), "utf-8"));
    after.project.lastUpdated = first.project.lastUpdated;
    expect(after).toEqual(first);
    // And the snapshot dedup saw it: one distinct state, not two.
    expect(listSnapshots(tempDir)).toHaveLength(1);
  });

  it("the migrated document is still honest to the drift engine", () => {
    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(writeArchitecture(tempDir, read.data).success).toBe(true);

    const after = readArchitecture(tempDir);
    expect(after.success).toBe(true);
    if (!after.success) return;

    const report = detectDrift(after.data as unknown as Architecture, {
      hasPackageJson: true,
      dependencies: ["handlebars", "zod", "@modelcontextprotocol/sdk"],
      imports: [],
      parseCoverage: 1,
      filesScanned: 1,
      filesUnreadable: 0,
      filesTruncated: 0,
      bytesScanned: 10,
      roots: ["src"],
      truncated: false,
      scanNotes: [],
    });
    expect(report.warnings.filter((w) => w.kind === "dangling-edge")).toEqual([]);
    expect(report.warnings.filter((w) => w.kind === "orphan-subject")).toEqual([]);
  });

  it("is idempotent at the read level: reading never converges towards a write", () => {
    const before = readArchitecture(tempDir);
    expect(before.success).toBe(true);
    const mtimeBefore = statSync(architecturePath(tempDir)).mtimeMs;

    for (let i = 0; i < 3; i += 1) readArchitecture(tempDir);

    expect(statSync(architecturePath(tempDir)).mtimeMs).toBe(mtimeBefore);
    expect(JSON.parse(readFileSync(architecturePath(tempDir), "utf-8"))).not.toHaveProperty(
      "schemaVersion"
    );
  });
});

/**
 * The projection contract.
 *
 * Issue 0004 §4 requires the deprecated `services[]` / `connections[]` to keep
 * working "during the transition", and says plainly: "if it survives, it must
 * never be authored directly, because a hand-editable derived field is a drift
 * source."
 *
 * These tests are what make that true rather than aspirational.
 */
describe("the services projection is derived, not authored", () => {
  let tempDir: string;
  let v1: { services: Array<{ id: string }> };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-projection-"));
    mkdirSync(arkiveDirPath(tempDir), { recursive: true });
    writeFileSync(
      architecturePath(tempDir),
      readFileSync(LEGACY, "utf-8"),
      "utf-8"
    );
    v1 = JSON.parse(readFileSync(LEGACY, "utf-8"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("what is on disk is exactly what the graph projects", () => {
    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(writeArchitecture(tempDir, read.data).success).toBe(true);

    const onDisk = JSON.parse(readFileSync(architecturePath(tempDir), "utf-8"));
    const derived = projectDocument(onDisk);
    expect(onDisk.services).toEqual(derived.services);
    expect(onDisk.connections).toEqual(derived.connections);
  });

  it("an edit to the stored copy alone is invisible to the next read", () => {
    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(writeArchitecture(tempDir, read.data).success).toBe(true);

    // A hand-edit to `services[]` — exactly what the `architecture-tracker`
    // skill tells an agent to do.
    const tampered = JSON.parse(readFileSync(architecturePath(tempDir), "utf-8"));
    tampered.services.splice(1, 1);
    tampered.services[0].name = "HAND EDITED";
    writeFileSync(architecturePath(tempDir), `${JSON.stringify(tampered, null, 2)}\n`, "utf-8");

    const after = readArchitecture(tempDir);
    expect(after.success).toBe(true);
    if (!after.success) return;

    // The graph is the truth, so the projection comes back from the graph.
    expect(after.data.services).toHaveLength(EXPECTED.services);
    expect(after.data.services.map((s) => s.id)).toEqual(v1.services.map((s) => s.id));
    expect(after.data.services[0].name).toBe("CLI");
    expect(after.data.services.map((s) => s.name)).not.toContain("HAND EDITED");
  });

  it("but an edit through the v1 authoring surface does land", () => {
    // `update_architecture` mutates `arch.services` and writes it back. A write
    // path that ignored the array would report success and change nothing —
    // a silent no-op, the worst thing a persistence layer can do.
    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;

    read.data.services.push({
      id: "worker",
      name: "Worker",
      type: "backend",
      technology: "BullMQ",
      description: "Background jobs",
      dependencies: ["cli"],
      kind: "service",
    });
    expect(writeArchitecture(tempDir, read.data).success).toBe(true);

    const after = readArchitecture(tempDir);
    expect(after.success).toBe(true);
    if (!after.success) return;
    expect(after.data.services.map((s) => s.id)).toContain("worker");

    // ...and it landed as a node, not as a string in an array.
    const node = after.data.nodes.find((n) => n.id === "worker");
    expect(node?.kind).toBe("service");
    expect(node?.tech).toBe("BullMQ");
    // And the dependency became an edge.
    expect(after.data.edges.some((e) => e.kind === "imports" && e.from === "worker" && e.to === "cli")).toBe(true);
  });

  it("a v2-native edit to `nodes` is not undone by the stale v1 view beside it", () => {
    // The trap this guards is the one the issue names: "a hand-editable derived
    // field is a drift source". If the deprecated view could delete the graph it
    // is derived from, a caller who adds a node to `nodes` and does not also
    // update the `services[]` array sitting next to it would have that node
    // silently tombstoned by the next write.
    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;

    read.data.nodes.push({
      id: "derived-reader",
      kind: "module",
      name: "src/reader",
      summary: "Derived by a rule, not by an author",
      provenance: { derived: true, rule: "module-derivation", evidence: ["src/reader/index.ts:1"] },
    });
    // `services` is deliberately NOT updated — that is the mistake being tested.
    expect(read.data.services.some((s) => s.id === "derived-reader")).toBe(false);

    expect(writeArchitecture(tempDir, read.data).success).toBe(true);

    const after = readArchitecture(tempDir);
    expect(after.success).toBe(true);
    if (!after.success) return;
    const node = after.data.nodes.find((n) => n.id === "derived-reader");
    expect(node, "a v2-native node was tombstoned by the deprecated view").toBeDefined();
    expect(node?.deletedAt).toBeUndefined();
  });

it("a v1 removal does tombstone, and records the cascade", () => {
    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;

    read.data.services = read.data.services.filter((s) => s.id !== "learning");
    expect(writeArchitecture(tempDir, read.data).success).toBe(true);

    const after = readArchitecture(tempDir);
    expect(after.success).toBe(true);
    if (!after.success) return;

    expect(after.data.services.map((s) => s.id)).not.toContain("learning");
    const node = after.data.nodes.find((n) => n.id === "learning");
    expect(node).toBeDefined();
    expect(node?.deletedAt).toBeTruthy();
    expect(after.data.history.some((h) => h.action === "remove_node")).toBe(true);
  });

  it("the write path refuses a v1 edit that references a node that does not exist", () => {
    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;

    read.data.connections.push({
      from: "cli",
      to: "does-not-exist",
      protocol: "HTTP",
      description: "typo",
      kind: "calls",
    });
    const write = writeArchitecture(tempDir, read.data);
    expect(write.success).toBe(false);
    if (write.success) return;
    expect(write.error).toContain("does-not-exist");
    // Nothing was written.
    expect(JSON.parse(readFileSync(architecturePath(tempDir), "utf-8"))).not.toHaveProperty(
      "schemaVersion"
    );
  });

  it("a v1 `type` cannot become graph semantics — it is kept as data, not structure", () => {
    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;

    // `frontend` is a v1 deployment label, not a v2 node kind. ADR-0001 deletes
    // the taxonomy; the value is kept verbatim so the projection round-trips,
    // and nothing traverses on it.
    const viewer = read.data.nodes.find((n) => n.id === "viewer");
    expect(viewer?.kind).toBe("service");
    expect((viewer as unknown as Record<string, unknown>).legacyType).toBe("frontend");
    expect(JSON.stringify(read.data.nodes)).not.toContain('"kind":"frontend"');
  });

  it("tombstoned nodes leave the projection but stay in the graph", () => {
    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;

    read.data.services = read.data.services.filter((s) => s.id !== "viewer");
    expect(writeArchitecture(tempDir, read.data).success).toBe(true);

    const after = readArchitecture(tempDir);
    expect(after.success).toBe(true);
    if (!after.success) return;

    expect(after.data.nodes.some((n) => n.id === "viewer")).toBe(true);
    expect(after.data.services.some((s) => s.id === "viewer")).toBe(false);
    // `dec-003` explains the viewer. Deleting the node must not destroy it.
    const dec003 = after.data.decisions.find((d) => d.id === "dec-003");
    expect(dec003?.subjects).toContainEqual({ kind: "node", ref: "viewer" });
    expect(dec003?.rationale).toContain("React");
  });
});