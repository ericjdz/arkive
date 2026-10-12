import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  architecturePath,
  readArchitecture,
  writeArchitecture,
} from "../../src/io/architecture-file.js";
import { createEmptyArchitectureV2 } from "../../src/schema/validate-graph.js";
import type { ArchitectureDocumentV2, GraphNode } from "../../src/schema/graph.js";
import {
  DEFAULT_WATCH_INTERVAL_MS,
  describeOutcome,
  formatDelta,
  reconcileOnce,
  startWatch,
} from "../../src/analysis/watch.js";
import type { ReconcileOutcome } from "../../src/analysis/watch.js";
import { isHumanVerified, mergeDerived } from "../../src/analysis/derive.js";
import { deriveModules } from "../../src/analysis/derive.js";

/**
 * Continuous reconciliation — `docs/issues/0007-continuous-reconciliation.md`.
 *
 * The issue is the one that makes ADR-0002's central claim true. Everything
 * before it built a derivation engine and reported on it; without persistence the
 * 231 module nodes this repository derives were never written anywhere, and
 * "the derived half cannot drift" was a property of a function nobody called.
 *
 * These tests are written around the four claims the issue makes, and around the
 * failure modes that make each of them false:
 *
 * 1. **The refresh is safe to run repeatedly.** The acceptance criterion is "an
 *    authored node survives 100 reconcile cycles". It is asserted on the bytes on
 *    disk, not on the in-memory merge — a merge that preserved the node while the
 *    writer stamped a new `lastUpdated` on every cycle would pass the weaker test
 *    and still dirty the repository forever.
 * 2. **Authored drift is detected and it is `critical`.** A `human-verified`
 *    service whose technology has left `package.json` is the real finding. A
 *    derived node that moved is not, and a rule that fired on both would be
 *    noise.
 * 3. **Orphans are asked about, never deleted.** This is the 62066bc failure
 *    class: a silent removal that leaves a decision's `subjects[]` resolving
 *    against nothing.
 * 4. **The output is a delta.** A redump of 231 nodes is not a report; it is a
 *    scroll.
 */

function write(dir: string, relPath: string, content: string): void {
  const full = join(dir, ...relPath.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

/** A human-verified service node. The thing that must survive every cycle. */
function humanService(id: string, tech: string): GraphNode {
  return {
    id,
    kind: "service",
    name: "API",
    summary: "A human wrote this summary, and it is the only record of why.",
    tech,
    provenance: { derived: false, authoredBy: "human", reviewedAt: "2026-01-01T00:00:00.000Z" },
  };
}

function reconciled(dir: string, apply = false): Extract<ReconcileOutcome, { status: "reconciled" }> {
  const outcome = reconcileOnce(dir, { apply });
  if (outcome.status !== "reconciled") {
    throw new Error(`expected a reconciled outcome, got ${outcome.status}`);
  }
  return outcome;
}

function documentOnDisk(dir: string): string {
  return readFileSync(architecturePath(dir), "utf-8");
}

/**
 * Persist a read document as a **pure v2 graph**, dropping the deprecated view.
 *
 * `readArchitecture` attaches `services` / `connections`, and `writeArchitecture`
 * folds a v1 view back onto the graph before persisting. Hand it that view
 * alongside a mutated `nodes` array and the fold overwrites the new values with
 * the stale projected ones — a `summary` edit comes back empty. Stripping the
 * view is how a v2-native edit is meant to be written, and it is exactly what
 * `reconcileOnce` does before persisting a derivation.
 */
function writePureGraph(dir: string, document: Record<string, unknown>): void {
  const payload: Record<string, unknown> = { ...document, schemaVersion: 2 };
  delete payload.services;
  delete payload.connections;
  delete payload.version;
  delete payload.warnings;
  if (!writeArchitecture(dir, payload as never).success) throw new Error("write failed");
}

describe("acceptance: an authored node survives 100 reconcile cycles", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-watch-100-"));
    write(tempDir, "package.json", JSON.stringify({ dependencies: { express: "^4.0.0" } }));
    write(tempDir, "src/a.ts", `import express from "express";\nexport const a = 1;\n`);
    write(tempDir, "src/b.ts", `export const b = 2;\n`);

    const arch = createEmptyArchitectureV2("hundred", "Hundred cycles");
    arch.nodes.push(humanService("svc:api", "express"));
    if (!writeArchitecture(tempDir, arch).success) throw new Error("scaffold failed");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("the node is byte-identical on disk after 100 persisted cycles", () => {
    // One cycle to write the derived half, then 100 more on a settled tree.
    reconciled(tempDir, true);
    const before = documentOnDisk(tempDir);
    const beforeNode = JSON.parse(before).nodes.find((n: GraphNode) => n.id === "svc:api");

    for (let cycle = 0; cycle < 100; cycle += 1) {
      reconciled(tempDir, true);
    }

    const after = documentOnDisk(tempDir);
    const afterNode = JSON.parse(after).nodes.find((n: GraphNode) => n.id === "svc:api");

    // Not "the summary survived" — the entire node, byte for byte, including
    // its `reviewedAt`. A reconciliation that rewrote the provenance timestamp on
    // every cycle would be asserting a review that never happened.
    expect(afterNode).toEqual(beforeNode);
    expect(afterNode.summary).toBe("A human wrote this summary, and it is the only record of why.");
    expect(afterNode.provenance).toEqual({
      derived: false,
      authoredBy: "human",
      reviewedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(afterNode.deletedAt).toBeUndefined();
    // ...and the document as a whole. A watcher that rewrote `lastUpdated` on
    // every tick would leave `nodes` intact and make the repository unusable.
    expect(after).toBe(before);
  }, 120_000);

  it("writes once, then does not write again", () => {
    // The same property, measured rather than compared: the no-change guard is
    // what makes a long-running watcher usable. Without it, `arkive watch` on a
    // quiet tree dirties the git index forever and `git status` is noise.
    const first = reconciled(tempDir, true);
    expect(first.written).toBe(true);
    expect(first.delta.addedNodes.length).toBeGreaterThan(0);

    for (let cycle = 0; cycle < 20; cycle += 1) {
      const steady = reconciled(tempDir, true);
      expect(steady.delta.noChange).toBe(true);
      expect(steady.written).toBe(false);
    }
  }, 120_000);

  it("counts the authored element derivation collided with, and keeps the ones it did not", () => {
    // Two different protections, and both matter. `svc:api` has an id no rule
    // produces, so it is kept by the "not in freshIds, authored" branch.
    // `module:src/a.ts` below is authored *under a derived id*, which is the
    // collision rule 1 exists for — derivation had the node in hand and declined
    // to overwrite the human's copy.
    reconciled(tempDir, true);

    // Authored as a **pure v2 graph**, deliberately — see `writePureGraph`.
    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    const target = read.data.nodes.find((n) => n.id === "module:src/a.ts");
    if (target === undefined) throw new Error("fixture did not derive");
    target.summary = "The human half of a structurally-derived node.";
    target.owner = "platform-team";
    target.provenance = {
      derived: false,
      authoredBy: "human",
      reviewedAt: "2026-01-01T00:00:00.000Z",
    };
    writePureGraph(tempDir, read.data as unknown as Record<string, unknown>);

    const steady = reconciled(tempDir, true);
    expect(steady.merge.preservedAuthored).toBeGreaterThan(0);

    // ...and the human's half of it survived the refresh, including the fields
    // derivation would otherwise have regenerated.
    const after = readArchitecture(tempDir);
    if (!after.success) throw new Error(after.error);
    const node = after.data.nodes.find((n) => n.id === "module:src/a.ts");
    expect(node?.summary).toBe("The human half of a structurally-derived node.");
    expect(node?.owner).toBe("platform-team");
    expect(node?.provenance.derived).toBe(false);
  });

  it("survives the cycle where the authored node's own file changes underneath it", () => {
    reconciled(tempDir, true);

    // The realistic collision: derivation produces `module:src/a.ts` and a human
    // has written a `service` node in the same document. Adding a file must not
    // shift anything.
    write(tempDir, "src/c.ts", `export const c = 3;\n`);
    const after = reconciled(tempDir, true);

    expect(after.delta.addedNodes).toContain("module:src/c.ts");
    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    const node = read.data.nodes.find((n) => n.id === "svc:api");
    expect(node?.summary).toBe("A human wrote this summary, and it is the only record of why.");
  });
});

describe("the derived half refreshes, the authored half does not", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-watch-split-"));
    write(tempDir, "package.json", JSON.stringify({ dependencies: { express: "^4.0.0" } }));
    write(tempDir, "src/a.ts", `import express from "express";\nexport const a = 1;\n`);

    const arch = createEmptyArchitectureV2("split", "Split");
    arch.nodes.push(humanService("svc:api", "express"));
    if (!writeArchitecture(tempDir, arch).success) throw new Error("scaffold failed");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("a new file adds a node to the persisted graph", () => {
    const before = readArchitecture(tempDir);
    if (!before.success) throw new Error(before.error);
    expect(before.data.nodes.some((n) => n.id === "module:src/a.ts")).toBe(false);

    const outcome = reconciled(tempDir, true);

    expect(outcome.delta.addedNodes).toContain("module:src/a.ts");
    expect(outcome.written).toBe(true);
    const after = readArchitecture(tempDir);
    if (!after.success) throw new Error(after.error);
    expect(after.data.nodes.some((n) => n.id === "module:src/a.ts")).toBe(true);
  });

  it("a new import adds an edge and an external node", () => {
    reconciled(tempDir, true);
    write(tempDir, "src/a.ts", `import express from "express";\nimport { z } from "zod";\n`);

    const outcome = reconciled(tempDir, true);

    expect(outcome.delta.addedNodes).toContain("external:npm:zod");
    expect(outcome.delta.addedEdges).toBeGreaterThan(0);
    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    expect(
      read.data.edges.some(
        (edge) => edge.from === "module:src/a.ts" && edge.to === "external:npm:zod"
      )
    ).toBe(true);
  });

  it("a deleted derived file is tombstoned, never hard-deleted", () => {
    reconciled(tempDir, true);
    unlinkSync(join(tempDir, "src", "a.ts"));

    const outcome = reconciled(tempDir, true);

    expect(outcome.delta.removedNodes).toContain("module:src/a.ts");
    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    // ADR-0001:129-137 — a soft delete. Edges and decisions reference it.
    const node = read.data.nodes.find((n) => n.id === "module:src/a.ts");
    expect(node).toBeDefined();
    expect(node?.deletedAt).toBeTruthy();
  });

  it("records the removal in history, because a silent tombstone is a tombstone nobody cleans up", () => {
    reconciled(tempDir, true);
    unlinkSync(join(tempDir, "src", "a.ts"));
    reconciled(tempDir, true);

    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    const entry = read.data.history.find((h) => h.action === "derive_refresh");
    expect(entry).toBeDefined();
    expect(entry?.summary).toMatch(/module:src\/a\.ts/);
  });

  it("does not write a history entry for a refresh that only added nodes", () => {
    // Bounded growth is by construction (ADR-0002:165-170). A watcher that
    // appended an entry per cycle would fill `history[]` to its 50-entry cap in
    // an afternoon and set a sticky `historyTruncated` a human has to clear.
    reconciled(tempDir, true);
    write(tempDir, "src/new.ts", `export const n = 1;\n`);
    reconciled(tempDir, true);

    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    expect(read.data.history.some((h) => h.action === "derive_refresh")).toBe(false);
  });

  it("the persisted document is never written through the deprecated v1 projection", () => {
    // `readArchitecture` attaches `services`/`connections`, and `writeArchitecture`
    // folds a v1 view back onto the graph. Handing derivation's output through
    // that fold would let a projection computed *from* the graph edit the graph,
    // which is the "hand-editable derived field is a drift source" failure
    // `foldV1ViewOntoGraph` exists to prevent.
    write(tempDir, "src/b.ts", `export const b = 2;\n`);
    reconciled(tempDir, true);

    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    // Every live node projects to a v1 service, so the round trip is the check:
    // if the fold had run over derivation's output it would have written
    // `legacyType` onto every derived module node, which is what makes a node
    // removable through the deprecated surface.
    for (const node of read.data.nodes) {
      expect(node).not.toHaveProperty("legacyType");
    }
  });
});

describe("acceptance: authored drift raises critical and names the node", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-authored-drift-"));
    write(tempDir, "package.json", JSON.stringify({ dependencies: { express: "^4.0.0" } }));
    write(tempDir, "src/a.ts", `import express from "express";\nexport const a = 1;\n`);

    const arch = createEmptyArchitectureV2("drift", "Authored drift");
    arch.nodes.push(humanService("svc:api", "express"));
    if (!writeArchitecture(tempDir, arch).success) throw new Error("scaffold failed");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("a human-verified technology that left package.json is critical", () => {
    write(tempDir, "package.json", JSON.stringify({ dependencies: {} }));

    const outcome = reconciled(tempDir, false);

    const finding = outcome.findings.find((f) => f.kind === "authored-unsupported");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("critical");
    // "names the node" — a finding a reader cannot attribute is not actionable.
    expect(finding?.subject).toBe("svc:api");
    expect(finding?.message).toMatch(/express/);
    expect(finding?.message).toMatch(/package\.json/);
    expect(finding?.suggestion).toBeTruthy();
  });

  it("says nothing while the technology is still declared", () => {
    const outcome = reconciled(tempDir, false);
    expect(outcome.findings.filter((f) => f.kind === "authored-unsupported")).toEqual([]);
  });

  it("does not fire on a derived node that moved", () => {
    // The half of the sentence the issue is actually about: "A derived node that
    // moved is not [a problem], it is Tuesday." `external:npm:express` is derived
    // and disappears from the manifest in the next test; it must stay silent.
    reconciled(tempDir, true);
    write(tempDir, "package.json", JSON.stringify({ dependencies: {} }));

    const outcome = reconciled(tempDir, false);
    expect(outcome.findings.every((f) => f.subject !== "external:npm:express")).toBe(true);
  });

  it("an agent-authored claim is a warning, not a critical", () => {
    // Who is wrong is the difference. A human's unsupported claim is asserted
    // knowledge; an agent's is a guess, and reporting both at the same severity
    // is how a report gets filtered by severity and then ignored.
    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    const node = read.data.nodes.find((n) => n.id === "svc:api");
    if (node === undefined) throw new Error("fixture missing");
    node.provenance = { derived: false, authoredBy: "agent" };
    writePureGraph(tempDir, read.data as unknown as Record<string, unknown>);

    write(tempDir, "package.json", JSON.stringify({ dependencies: {} }));
    const outcome = reconciled(tempDir, false);

    const finding = outcome.findings.find((f) => f.kind === "authored-unsupported");
    expect(finding?.severity).toBe("warning");
    expect(finding?.humanVerified).toBe(false);
  });

  it("treats a migrated v1 `source: \"human-verified\"` as human provenance", () => {
    // `carryLegacyServiceFields` keeps the field so a detector does not go quiet
    // after an upgrade. That promise only holds if something reads it, and
    // `isHumanVerified` is the reader.
    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    const node = read.data.nodes.find((n) => n.id === "svc:api");
    if (node === undefined) throw new Error("fixture missing");
    node.provenance = { derived: false, authoredBy: "agent" };
    (node as unknown as Record<string, unknown>).source = "human-verified";
    writePureGraph(tempDir, read.data as unknown as Record<string, unknown>);

    expect(isHumanVerified(node)).toBe(true);
    write(tempDir, "package.json", JSON.stringify({ dependencies: {} }));
    expect(reconciled(tempDir, false).findings[0]?.severity).toBe("critical");
  });

  it("matches across naming conventions rather than on exact strings", () => {
    // `tech: "Postgres"` against `pg`, and a scoped package against its short
    // name. Exact matching would fire a critical on essentially every real
    // project, and a critical that always fires is one nobody reads.
    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    const node = read.data.nodes.find((n) => n.id === "svc:api");
    if (node === undefined) throw new Error("fixture missing");
    node.tech = "Express";
    writePureGraph(tempDir, read.data as unknown as Record<string, unknown>);

    expect(reconciled(tempDir, false).findings).toEqual([]);
  });

  it("does not report a two-character package as unsupported when it is declared", () => {
    // Regression, found by running the demo rather than by reasoning: `pg` is
    // declared in `package.json`, and a length guard applied to *both* sides of
    // the containment check threw away the exact match and raised a `critical`
    // on a correct document. Two characters is short enough that a
    // substring-match guard would fire on `js` in `expressjs` — so the guard is
    // per-direction, and this is the test that says so.
    write(tempDir, "src/db.ts", `import { Client } from "pg";\nexport const c = new Client();\n`);
    write(
      tempDir,
      "package.json",
      JSON.stringify({ dependencies: { express: "^4.0.0", pg: "^8.0.0" } })
    );

    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    const node = read.data.nodes.find((n) => n.id === "svc:api");
    if (node === undefined) throw new Error("fixture missing");
    node.tech = "pg";
    writePureGraph(tempDir, read.data as unknown as Record<string, unknown>);

    const outcome = reconciled(tempDir, false);
    expect(outcome.findings.filter((f) => f.kind === "authored-unsupported")).toEqual([]);
  });

  it("accepts a short dependency named inside a longer technology string", () => {
    // The unguarded direction. "Postgres over pg" naming `pg` is evidence, not
    // noise — the package is being named, not coincidentally contained.
    write(tempDir, "src/db.ts", `import { Client } from "pg";\nexport const c = new Client();\n`);
    write(
      tempDir,
      "package.json",
      JSON.stringify({ dependencies: { express: "^4.0.0", pg: "^8.0.0" } })
    );

    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    const node = read.data.nodes.find((n) => n.id === "svc:api");
    if (node === undefined) throw new Error("fixture missing");
    node.tech = "Postgres over pg";
    writePureGraph(tempDir, read.data as unknown as Record<string, unknown>);

    expect(reconciled(tempDir, false).findings).toEqual([]);
  });

  it("still fires on a genuinely absent technology, whatever its length", () => {
    // The counterpart: the fix must not have turned the check off.
    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    const node = read.data.nodes.find((n) => n.id === "svc:api");
    if (node === undefined) throw new Error("fixture missing");
    node.tech = "pg";
    writePureGraph(tempDir, read.data as unknown as Record<string, unknown>);

    const outcome = reconciled(tempDir, false);
    expect(outcome.findings.map((f) => f.subject)).toContain("svc:api");
    expect(outcome.findings[0]?.severity).toBe("critical");
  });

  it("suppresses the check entirely when the scan could not judge the manifest", () => {
    // No manifest. Silence from a rule that could not run is not a verdict, and
    // `missing-manifest` is already a critical — a second one naming every node
    // would bury it.
    rmSync(join(tempDir, "package.json"));
    const outcome = reconciled(tempDir, false);
    expect(outcome.findings.filter((f) => f.kind === "authored-unsupported")).toEqual([]);
    expect(outcome.drift.warnings.some((w) => w.kind === "missing-manifest")).toBe(true);
  });

  it("suppresses the check when a source file could not be parsed", () => {
    // A rule that fires on 40% of the files is worse than one that does not fire
    // (ADR-0002:150-152). Coverage below 1 means the walk did not finish looking.
    write(tempDir, "src/unreadable.rb", `puts 1\n`);
    const outcome = reconciled(tempDir, false);
    expect(outcome.scan.parseCoverage).toBeLessThan(1);
    expect(outcome.findings.filter((f) => f.kind === "authored-unsupported")).toEqual([]);
  });
});

describe("acceptance: an orphaned human-verified node is reported, not deleted", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-orphan-"));
    write(tempDir, "package.json", JSON.stringify({ dependencies: { express: "^4.0.0" } }));
    write(tempDir, "src/a.ts", `import express from "express";\nexport const a = 1;\n`);
    write(tempDir, "src/legacy.ts", `export const legacy = 1;\n`);

    const arch = createEmptyArchitectureV2("orphan", "Orphan");
    arch.nodes.push({
      id: "module:src/legacy.ts",
      kind: "module",
      name: "legacy.ts",
      summary: "A human wrote this about a file that is about to disappear.",
      path: "src/legacy.ts",
      provenance: { derived: false, authoredBy: "human", reviewedAt: "2026-01-01T00:00:00.000Z" },
    });
    if (!writeArchitecture(tempDir, arch).success) throw new Error("scaffold failed");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("raises critical, names the node, and leaves it exactly where it was", () => {
    reconciled(tempDir, true);
    unlinkSync(join(tempDir, "src", "legacy.ts"));

    const outcome = reconciled(tempDir, true);

    const finding = outcome.findings.find((f) => f.kind === "orphaned-authored");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("critical");
    expect(finding?.subject).toBe("module:src/legacy.ts");
    expect(finding?.message).toMatch(/kept exactly as it was/);

    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    const node = read.data.nodes.find((n) => n.id === "module:src/legacy.ts");
    // Ask, never delete. The 62066bc failure class is a silent removal that
    // leaves a decision's `subjects[]` resolving against nothing.
    expect(node).toBeDefined();
    expect(node?.deletedAt).toBeUndefined();
    expect(node?.summary).toBe("A human wrote this about a file that is about to disappear.");
    expect(node?.provenance).toEqual({
      derived: false,
      authoredBy: "human",
      reviewedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("stays an orphan across repeated cycles and never escalates to a deletion", () => {
    unlinkSync(join(tempDir, "src", "legacy.ts"));
    reconciled(tempDir, true);

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const outcome = reconciled(tempDir, true);
      expect(outcome.findings.filter((f) => f.kind === "orphaned-authored")).toHaveLength(1);
    }

    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    expect(read.data.nodes.some((n) => n.id === "module:src/legacy.ts")).toBe(true);
  });

  it("never calls an authored service or datastore an orphan", () => {
    // ADR-0002:72-75 puts "is this the right boundary" on the human side. A rule
    // that flagged every authored `service` would fire on every project, and a
    // critical that fires constantly is a critical nobody reads.
    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    read.data.nodes.push(humanService("svc:payments", "redis"));
    read.data.nodes.push({
      id: "datastore:pg",
      kind: "datastore",
      name: "Primary store",
      summary: "The primary datastore.",
      tech: "pg",
      provenance: { derived: false, authoredBy: "human" },
    });
    writePureGraph(tempDir, read.data as unknown as Record<string, unknown>);

    reconciled(tempDir, true);
    // Only the module node becomes an orphan; the file it names is gone.
    unlinkSync(join(tempDir, "src", "legacy.ts"));

    const outcome = reconciled(tempDir, false);
    const orphans = outcome.findings.filter((f) => f.kind === "orphaned-authored");
    expect(orphans.map((f) => f.subject)).toEqual(["module:src/legacy.ts"]);
  });

  it("stays silent when the scan derived nothing of the node's kind", () => {
    // A project with no third-party imports derives zero `external` nodes. An
    // authored `external:npm:redis` in it is not contradicted by the absence —
    // the absence is the scan's coverage, not a fact about the graph.
    const bare = mkdtempSync(join(tmpdir(), "arkive-orphan-bare-"));
    try {
      write(bare, "package.json", JSON.stringify({ dependencies: {} }));
      write(bare, "src/plain.ts", `export const p = 1;\n`);
      const arch = createEmptyArchitectureV2("bare", "Bare");
      arch.nodes.push({
        id: "external:npm:redis",
        kind: "external",
        name: "redis",
        summary: "A human recorded this as a dependency of the system.",
        provenance: { derived: false, authoredBy: "human" },
      });
      if (!writeArchitecture(bare, arch).success) throw new Error("scaffold failed");

      const outcome = reconcileOnce(bare, {});
      if (outcome.status !== "reconciled") throw new Error("status");
      expect(outcome.derivation.nodes.some((n) => n.kind === "external")).toBe(false);
      expect(outcome.findings.filter((f) => f.kind === "orphaned-authored")).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("does not call a node an orphan when derivation reproduced it under the same id", () => {
    reconciled(tempDir, true);
    const outcome = reconciled(tempDir, false);
    // `module:src/legacy.ts` was authored but derivation produces the same id;
    // the two halves agree, so it is corroborated, not orphaned.
    expect(outcome.findings.filter((f) => f.subject === "module:src/legacy.ts")).toEqual([]);
  });
});

describe("acceptance: the output is a delta, not a wall", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-delta-"));
    write(tempDir, "package.json", JSON.stringify({ dependencies: { express: "^4.0.0" } }));
    for (let i = 0; i < 40; i += 1) {
      write(tempDir, `src/file-${i}.ts`, `import express from "express";\nexport const v = ${i};\n`);
    }
    const arch = createEmptyArchitectureV2("delta", "Delta");
    if (!writeArchitecture(tempDir, arch).success) throw new Error("scaffold failed");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("says what changed in one sentence, not by listing the graph", () => {
    const outcome = reconciled(tempDir, false);
    const text = describeOutcome(outcome, false);

    // One headline, three samples, one overflow line. The graph here is 42 nodes;
    // the report is five lines regardless of that number, because a report
    // nobody reaches the end of is a report nobody reads.
    expect(text.split("\n").length).toBeLessThanOrEqual(5);
    expect(text).toMatch(/\d+ nodes added/);
    expect(text).toContain("… and");
    // ...and it does not enumerate what the graph already contained.
    expect(text).not.toContain("module:src/file-20.ts");
  });

  it("states the diagnostic as a proposal and the applied form as a fact", () => {
    const outcome = reconciled(tempDir, false);
    // "Would 4 nodes added" would read as an assertion; the prospective form has
    // to be genuinely conditional or `reconcile` is lying about a document it did
    // not touch.
    expect(describeOutcome(outcome, false)).toMatch(/^Would \d+ nodes added/);
    expect(describeOutcome(outcome, true)).toMatch(/^\d+ nodes added/);
  });

  it("says 'no change' rather than printing the whole graph on a quiet tree", () => {
    reconciled(tempDir, true);
    const steady = reconciled(tempDir, false);
    expect(formatDelta(steady.delta, steady.findings, false)).toBe(
      "No change. The derived half is already current."
    );
  });

  it("leads with the authored finding, not with a count of refreshed derived nodes", () => {
    write(tempDir, "src/plain.ts", `export const p = 1;\n`);
    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    read.data.nodes.push(humanService("svc:api", "express"));
    writePureGraph(tempDir, read.data as unknown as Record<string, unknown>);
    write(tempDir, "package.json", JSON.stringify({ dependencies: {} }));

    const outcome = reconciled(tempDir, false);
    const text = describeOutcome(outcome, false);
    const headline = text.split("\n")[0];

    expect(headline).toMatch(/human-verified claim no longer supported/);
    expect(headline).toMatch(/node/);
    // The refreshed-node count is not even mentioned: it is normal work, and the
    // one fact a reader acts on is the claim the manifest contradicts.
    expect(headline).not.toMatch(/replaced/);
  });
});

describe("the watch loop", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-watch-loop-"));
    write(tempDir, "package.json", JSON.stringify({ dependencies: { express: "^4.0.0" } }));
    write(tempDir, "src/a.ts", `import express from "express";\nexport const a = 1;\n`);
    const arch = createEmptyArchitectureV2("loop", "Loop");
    arch.nodes.push(humanService("svc:api", "express"));
    if (!writeArchitecture(tempDir, arch).success) throw new Error("scaffold failed");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("persists on its first cycle and then reports only real changes", async () => {
    const seen: string[] = [];
    const handle = startWatch({
      dir: tempDir,
      intervalMs: 5,
      onCycle: (outcome) => seen.push(describeOutcome(outcome, true)),
      onError: (error) => {
        throw error;
      },
    });

    // Wait for the first cycle to land.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    expect(read.data.nodes.some((n) => n.id === "module:src/a.ts")).toBe(true);
    expect(seen.length).toBe(1);

    // Now change something and wait for the next report.
    write(tempDir, "src/b.ts", `export const b = 2;\n`);
    await new Promise((resolve) => setTimeout(resolve, 400));

    handle.stop();
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toMatch(/module:src\/b\.ts/);

    const after = readArchitecture(tempDir);
    if (!after.success) throw new Error(after.error);
    expect(after.data.nodes.some((n) => n.id === "module:src/b.ts")).toBe(true);
    expect(after.data.nodes.find((n) => n.id === "svc:api")?.summary).toBe(
      "A human wrote this summary, and it is the only record of why."
    );
  }, 30_000);

  it("stays silent on a quiet tree", async () => {
    // A watcher that prints on every tick is a process whose output is
    // background noise, and then the one moment that matters is the moment it is
    // scrolled past.
    let cycles = 0;
    const handle = startWatch({
      dir: tempDir,
      intervalMs: 5,
      onCycle: () => {
        cycles += 1;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    handle.stop();

    // Exactly one report: the cycle that wrote the derived half.
    expect(cycles).toBe(1);
  }, 30_000);

  it("honours maxCycles and can be stopped before any cycle runs", async () => {
    let cycles = 0;
    const handle = startWatch({
      dir: tempDir,
      intervalMs: 1,
      maxCycles: 1,
      onCycle: () => {
        cycles += 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(cycles).toBe(1);

    handle.stop();
    const before = cycles;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cycles).toBe(before);
  }, 30_000);

  it("defaults to a one-second interval", () => {
    // Asserted because it is a user-visible cost: the loop re-walks the tree on
    // every tick, deliberately (issue 0011's argument applies), so the default
    // has to be one a user is not surprised by on a monorepo.
    expect(DEFAULT_WATCH_INTERVAL_MS).toBe(1000);
  });

  it("reports an absent document as absent, not as an empty graph", () => {
    const bare = mkdtempSync(join(tmpdir(), "arkive-watch-absent-"));
    try {
      const outcome = reconcileOnce(bare, { apply: true });
      expect(outcome.status).toBe("absent");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("reports an unreadable document rather than throwing", () => {
    const broken = mkdtempSync(join(tmpdir(), "arkive-watch-broken-"));
    try {
      write(broken, "package.json", "{}");
      write(broken, "arkive/architecture.json", "{ not json");
      const outcome = reconcileOnce(broken, { apply: true });
      expect(outcome.status).toBe("unreadable");
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it("never throws on a document that is not an architecture document", () => {
    const wrong = mkdtempSync(join(tmpdir(), "arkive-watch-wrong-"));
    try {
      write(wrong, "package.json", "{}");
      write(wrong, "arkive/architecture.json", JSON.stringify({ hello: "world" }));
      expect(() => reconcileOnce(wrong, { apply: true })).not.toThrow();
      expect(reconcileOnce(wrong, { apply: true }).status).toBe("unreadable");
    } finally {
      rmSync(wrong, { recursive: true, force: true });
    }
  });
});

describe("reconcile stays a diagnostic", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-watch-diagnostic-"));
    write(tempDir, "package.json", JSON.stringify({ dependencies: { express: "^4.0.0" } }));
    write(tempDir, "src/a.ts", `import express from "express";\nexport const a = 1;\n`);
    const arch = createEmptyArchitectureV2("diagnostic", "Diagnostic");
    arch.nodes.push(humanService("svc:api", "express"));
    if (!writeArchitecture(tempDir, arch).success) throw new Error("scaffold failed");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not write without apply, and says so prospectively", () => {
    // ADR-0002:113-114: reconcile is retained as a one-shot check. The command a
    // user runs while curious must not be the command that edits their record.
    const before = documentOnDisk(tempDir);
    const outcome = reconciled(tempDir, false);

    expect(outcome.written).toBe(false);
    expect(documentOnDisk(tempDir)).toBe(before);
    expect(describeOutcome(outcome, false)).toMatch(/^Would /);
  });

  it("writes with apply, and the document on disk then matches the report", () => {
    const before = readArchitecture(tempDir);
    if (!before.success) throw new Error(before.error);
    const outcome = reconciled(tempDir, true);
    const after = readArchitecture(tempDir);
    if (!after.success) throw new Error(after.error);

    expect(outcome.written).toBe(true);
    expect(after.data.nodes.length).toBeGreaterThan(before.data.nodes.length);
    for (const id of outcome.delta.addedNodes) {
      expect(after.data.nodes.some((n) => n.id === id)).toBe(true);
    }
  });

  it("reports the derivation even when the scan covered nothing", () => {
    const bare = mkdtempSync(join(tmpdir(), "arkive-watch-nothing-"));
    try {
      write(bare, "package.json", "{}");
      const arch = createEmptyArchitectureV2("nothing", "Nothing");
      if (!writeArchitecture(bare, arch).success) throw new Error("scaffold failed");
      const outcome = reconcileOnce(bare, {});
      if (outcome.status !== "reconciled") throw new Error("status");
      // A scan that found no source files is not entitled to say the graph is
      // current, and `incomplete-scan` says so.
      expect(outcome.drift.conclusive).toBe(false);
      expect(outcome.drift.warnings.some((w) => w.kind === "incomplete-scan")).toBe(true);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("mergeDerived reports what it did, in the vocabulary the issue uses", () => {
  it("counts additions, removals and preserved authored elements separately", () => {
    const dir = mkdtempSync(join(tmpdir(), "arkive-merge-delta-"));
    try {
      write(dir, "package.json", "{}");
      write(dir, "src/a.ts", `export const a = 1;\n`);

      const empty = createEmptyArchitectureV2("m", "M");
      const first = mergeDerived(empty, deriveModules(dir));
      expect(first.addedNodes).toContain("module:src/a.ts");
      expect(first.removedNodes).toEqual([]);

      // `b.ts` imports `a.ts`, so the new file brings both a node and an edge.
      write(dir, "src/b.ts", `import { a } from "./a.js";\nexport const b = a + 1;\n`);
      const second = mergeDerived(
        { nodes: first.nodes, edges: first.edges } as ArchitectureDocumentV2,
        deriveModules(dir)
      );
      expect(second.addedNodes).toContain("module:src/b.ts");
      expect(second.addedEdges).toBeGreaterThan(0);

      unlinkSync(join(dir, "src", "b.ts"));
      const third = mergeDerived(
        { nodes: second.nodes, edges: second.edges } as ArchitectureDocumentV2,
        deriveModules(dir)
      );
      expect(third.removedNodes).toContain("module:src/b.ts");
      expect(third.tombstoned).toBe(1);
      expect(third.droppedEdges).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not count a refreshed derived node as an addition", () => {
    // A refresh is normal work. Counting it as an addition is how a report turns
    // into a wall: "231 nodes added" on every cycle says nothing.
    const dir = mkdtempSync(join(tmpdir(), "arkive-merge-refresh-"));
    try {
      write(dir, "package.json", "{}");
      write(dir, "src/a.ts", `export const a = 1;\n`);
      const first = mergeDerived(createEmptyArchitectureV2("r", "R"), deriveModules(dir));
      const second = mergeDerived(
        { nodes: first.nodes, edges: first.edges } as ArchitectureDocumentV2,
        deriveModules(dir)
      );
      expect(second.replaced).toBeGreaterThan(0);
      expect(second.addedNodes).toEqual([]);
      expect(second.addedEdges).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});