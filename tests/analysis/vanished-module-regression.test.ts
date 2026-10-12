import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanProject } from "../../src/analysis/scanner.js";
import { deriveFromScan } from "../../src/analysis/derive.js";
import { detectDrift } from "../../src/analysis/drift.js";

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