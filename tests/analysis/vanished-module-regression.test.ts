import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanProject } from "../../src/analysis/scanner.js";
import { deriveFromScan, mergeDerived } from "../../src/analysis/derive.js";
import { detectDrift } from "../../src/analysis/drift.js";
import type { GraphEdge, GraphNode } from "../../src/schema/graph.js";

/**
 * Regression: `vanished-module` fired on every directory node, forever.
 *
 * A directory node's `path` is a directory. It was checked against
 * `scan.fileIndex`, which holds files. So `!fileIndex.has("src")` was always
 * true and every directory reported itself deleted, at `critical` severity.
 *
 * Measured on this repository before the fix: 461 derived nodes, 41 of them
 * directories, and **41 false criticals** — every one a directory that
 * `directoryIndex` confirmed still existed.
 *
 * That mattered more than a cosmetic warning. `vanished-module` is `critical`,
 * and the `pre-commit` gate blocks on it, so any user who ran
 * `reconcile --apply` would have had every subsequent commit blocked by
 * phantom alarms — and would have learned to bypass the gate, which is the
 * exact outcome the gate exists to prevent.
 *
 * The second test is the one that matters most: the fix must select the right
 * index, not disable the check. A `vanished-module` that never fires is the
 * original bug wearing the opposite sign.
 *
 * These use the real scanner and the real derivation rather than the mocks
 * the other drift tests use. The defect was precisely an interaction between
 * two real artifacts, so a mock cannot catch it.
 */
function buildRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "arkive-vanished-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: {} }),
    "utf-8"
  );
  mkdirSync(join(dir, "src", "db"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), 'import { q } from "./db/pool.js";\nexport const x = q;\n', "utf-8");
  writeFileSync(join(dir, "src", "db", "pool.ts"), "export const q = 1;\n", "utf-8");
  return dir;
}

function documentFor(dir: string) {
  const derivation = deriveFromScan(scanProject(dir));
  return {
    schemaVersion: 2,
    project: {
      name: "fixture",
      description: "d",
      created: "2026-01-01T00:00:00.000Z",
      lastUpdated: "2026-01-01T00:00:00.000Z",
    },
    stack: { language: [], runtime: [], framework: [], database: [], infrastructure: [] },
    nodes: derivation.nodes,
    edges: derivation.edges,
    decisions: [],
    dataFlows: [],
    history: [],
  } as never;
}

function driftFor(dir: string) {
  const scan = scanProject(dir);
  const derivation = deriveFromScan(scan);
  return { scan, derivation, report: detectDrift(documentFor(dir), scan as never) };
}

describe("vanished-module — directories are not files", () => {
  let dir: string;

  beforeAll(() => {
    dir = buildRepo();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not report a directory that exists as vanished", () => {
    const { scan, derivation, report } = driftFor(dir);

    const dirNodes = derivation.nodes.filter((n) => n.id.startsWith("module:dir:"));
    expect(dirNodes.length).toBeGreaterThan(0);

    // The precondition, stated so a future reader sees why this is not paranoia.
    for (const node of dirNodes) {
      expect(scan.fileIndex.has(node.path ?? "")).toBe(false);
      expect(scan.directoryIndex.has(node.path ?? "")).toBe(true);
    }

    const vanished = report.warnings.filter((w) => w.kind === "vanished-module");
    expect(vanished).toEqual([]);
  });

  it("still reports a file that was genuinely deleted", () => {
    // The document holds *yesterday's* derived graph; today's code no longer
    // has the file. Deriving fresh would simply not produce the node, so the
    // node under test has to come from the earlier scan — which is exactly
    // what `reconcile` sees on a real run.
    const docBefore = documentFor(dir);

    rmSync(join(dir, "src", "db", "pool.ts"), { force: true });

    const scanAfter = scanProject(dir);
    const report = detectDrift(docBefore, scanAfter as never);
    const vanished = report.warnings.filter((w) => w.kind === "vanished-module");

    expect(vanished.length).toBeGreaterThan(0);
    const subjects = vanished.map((w) => String(w.subject));
    expect(subjects.some((s) => s.includes("pool.ts"))).toBe(true);
    // The directory that still exists is still not reported.
    expect(subjects).not.toContain("module:dir:src/db");
  });
});

describe("vanished-module — config-excluded paths are out of scope, not vanished", () => {
  let dir: string;

  beforeAll(() => {
    dir = buildRepo();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The user told the walk not to look here. `src/db` is excluded by
  // explicit configuration, reported in `scanNotes` on every run — it is
  // out of scope, not evidence of deletion. Written after the "yesterday"
  // derivation in each test, mirroring a user who excludes a path that
  // already has derived nodes.
  function excludeDb(): void {
    writeFileSync(
      join(dir, "arkive.config.json"),
      JSON.stringify({ exclude: ["src/db"] }),
      "utf-8"
    );
  }

  it("does not report a live node under an excluded path as vanished", () => {
    // The discriminating case for the carve-out: the node is LIVE (no merge
    // has tombstoned anything) and its path is absent from the index purely
    // because the walk was told not to look. Without the carve-out this is
    // exactly the missingOnDisk signal and fires critical.
    const docBefore = documentFor(dir);
    excludeDb();
    const scanAfter = scanProject(dir);

    const report = detectDrift(docBefore, scanAfter as never);
    const vanished = report.warnings.filter((w) => w.kind === "vanished-module");
    expect(vanished).toEqual([]);
  });

  it("still reports a genuinely deleted file outside the exclusion", () => {
    // The carve-out is scoped to the excluded prefixes, not a disable: a
    // deletion elsewhere in the tree must still fire at critical.
    const docBefore = documentFor(dir);
    excludeDb();

    rmSync(join(dir, "src", "index.ts"), { force: true });

    const scanAfter = scanProject(dir);
    const report = detectDrift(docBefore, scanAfter as never);
    const vanished = report.warnings.filter((w) => w.kind === "vanished-module");
    const subjects = vanished.map((w) => String(w.subject));
    expect(subjects.some((s) => s.includes("index.ts"))).toBe(true);
    // And the excluded subtree stays silent throughout.
    expect(subjects.some((s) => s.includes("db"))).toBe(false);
  });
});

describe("vanished-module — a tombstone is the record, not a fresh alarm", () => {
  let dir: string;

  beforeAll(() => {
    dir = buildRepo();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("goes silent once reconcile records the disappearance as a tombstone", () => {
    // Full lifecycle: delete the file (unrecorded disappearance → critical),
    // then merge as `reconcile --apply` does (recorded tombstone → silent).
    // A tombstone re-alarming forever would make every reviewed deletion a
    // permanent critical no deliberate action clears — removal is
    // tombstone-only by design, and re-removing a tombstone is a no-op.
    const docBefore = documentFor(dir);

    rmSync(join(dir, "src", "db", "pool.ts"), { force: true });

    const scanAfter = scanProject(dir);
    const before = detectDrift(docBefore, scanAfter as never);
    expect(
      before.warnings
        .filter((w) => w.kind === "vanished-module")
        .map((w) => String(w.subject))
        .some((s) => s.includes("pool.ts"))
    ).toBe(true);

    const merged = mergeDerived(
      {
        nodes: (docBefore as unknown as { nodes: GraphNode[] }).nodes,
        edges: (docBefore as unknown as { edges: GraphEdge[] }).edges,
      },
      deriveFromScan(scanAfter)
    );
    const tombstoned = merged.nodes.filter((n) => n.deletedAt !== undefined);
    expect(tombstoned.length).toBeGreaterThan(0);

    const after = detectDrift(
      {
        ...(docBefore as unknown as Record<string, unknown>),
        nodes: merged.nodes,
        edges: merged.edges,
      } as never,
      scanAfter as never
    );
    expect(after.warnings.filter((w) => w.kind === "vanished-module")).toEqual([]);
  });
});