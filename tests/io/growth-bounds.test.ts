import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ARKIVE_DIR,
  MAX_HISTORY_ENTRIES,
  MAX_SNAPSHOTS,
  architecturePath,
  capHistory,
  listSnapshots,
  readArchitecture,
  readSnapshot,
  saveSnapshot,
  writeArchitecture,
} from "../../src/io/architecture-file.js";
import { createEmptyArchitectureV2 } from "../../src/schema/validate-graph.js";
import type { GraphNode } from "../../src/schema/graph.js";

/** A distinct v2 node, so every write below produces a genuinely new state. */
function node(id: string, name: string): GraphNode {
  return {
    id,
    kind: "service",
    name,
    summary: `state for ${name}`,
    provenance: { derived: false, authoredBy: "agent" },
  };
}

/**
 * Growth bounds. ADR-0002 and ADR-0006 §2.
 *
 * `saveSnapshot` used to write a full-document copy on *every* write, named
 * after `lastUpdated` with only `:` replaced — so two writes in the same
 * millisecond collided and the second silently overwrote the first, while every
 * distinct write added another file forever. `history[]` grew without bound.
 *
 * The durable record is git. The JSON file is a working document, not an
 * archive.
 */
describe("regression K — history[] is bounded and says so", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-history-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("caps 200 sequential updates at 50 entries with an explicit flag", () => {
    const arch = createEmptyArchitectureV2("growing", "Grows a lot");
    expect(writeArchitecture(tempDir, arch).success).toBe(true);

    for (let i = 0; i < 200; i += 1) {
      const read = readArchitecture(tempDir);
      if (!read.success) throw new Error(read.error);

      read.data.history.push({
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        action: "update_architecture",
        summary: `Update number ${i}`,
      });

      const write = writeArchitecture(tempDir, read.data);
      expect(write.success).toBe(true);
    }

    const final = readArchitecture(tempDir);
    expect(final.success).toBe(true);
    if (!final.success) return;

    expect(final.data.history.length).toBeLessThanOrEqual(MAX_HISTORY_ENTRIES);
    expect(final.data.history).toHaveLength(50);
    // Truncation is never silent.
    expect(final.data.historyTruncated).toBe(true);

    const onDisk = JSON.parse(readFileSync(architecturePath(tempDir), "utf-8")) as {
      history: unknown[];
      historyTruncated?: boolean;
    };
    expect(onDisk.history).toHaveLength(50);
    expect(onDisk.historyTruncated).toBe(true);
  }, 120_000);

  it("keeps the newest entries, not the oldest", () => {
    const arch = createEmptyArchitectureV2("newest", "Newest wins");
    for (let i = 0; i < 60; i += 1) {
      arch.history.push({
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        action: "update_architecture",
        summary: `entry-${i}`,
      });
    }

    const capped = capHistory(arch);

    expect(capped.history).toHaveLength(50);
    expect(capped.history[capped.history.length - 1].summary).toBe("entry-59");
    expect(capped.history[0].summary).toBe("entry-10");
  });

  it("leaves a document at or under the cap completely alone", () => {
    const arch = createEmptyArchitectureV2("small", "Small");
    const capped = capHistory(arch);
    expect(capped).toBe(arch);
    expect(capped.historyTruncated).toBeUndefined();
  });

  it("the flag is sticky — it is not cleared once history fits again", () => {
    const arch = createEmptyArchitectureV2("sticky", "Sticky") as ReturnType<
      typeof createEmptyArchitectureV2
    > & { historyTruncated?: boolean };
    for (let i = 0; i < 60; i += 1) {
      arch.history.push({
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        action: "update_architecture",
        summary: `entry-${i}`,
      });
    }

    const first = capHistory(arch);
    expect(first.historyTruncated).toBe(true);

    const second = capHistory({ ...first, history: first.history.slice(0, 3) });
    expect(second.historyTruncated).toBe(true);
  });

  it("a flag written by hand is not a reason to refuse the document", () => {
    const arch = createEmptyArchitectureV2("flagged", "Already flagged") as ReturnType<
      typeof createEmptyArchitectureV2
    > & { historyTruncated?: boolean };
    arch.historyTruncated = true;
    const write = writeArchitecture(tempDir, arch);
    expect(write.success).toBe(true);
    const read = readArchitecture(tempDir);
    expect(read.success && read.data.historyTruncated).toBe(true);
  });
});

describe("regression L — snapshots are bounded and deduplicated", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-snapshot-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("200 distinct writes produce at most 10 snapshot files", () => {
    for (let i = 0; i < 200; i += 1) {
      const arch = createEmptyArchitectureV2("snapshots", "Bounded");
      arch.nodes.push(node(`svc-${i}`, `Service ${i}`));
      const write = writeArchitecture(tempDir, arch);
      expect(write.success).toBe(true);
    }

    const historyDir = join(tempDir, ARKIVE_DIR, "history");
    const files = readdirSync(historyDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeLessThanOrEqual(MAX_SNAPSHOTS);
    expect(listSnapshots(tempDir)).toHaveLength(files.length);
  }, 120_000);

  it("identical content at a different timestamp is the same state, not a new one", () => {
    // `lastUpdated` changes on every write. Hashing the document as-is would
    // make every single write a "distinct state" and defeat the dedup.
    const base = createEmptyArchitectureV2("dedup", "Dedup");

    const first = saveSnapshot(tempDir, base);
    const second = saveSnapshot(tempDir, {
      ...base,
      project: { ...base.project, lastUpdated: "2099-12-31T23:59:59.999Z" },
    });

    expect(second).toBe(first);
    expect(listSnapshots(tempDir)).toHaveLength(1);
  });

  it("regression — two writes in the same millisecond no longer collide", () => {
    // The old filename replaced only `:` and left `.` intact, so
    // `2026-05-07T00:00:00.123Z` and `2026-05-07T00:00:00.456Z` produced
    // `2026-05-07T00-00-00.123Z.json` and `...456Z.json` — distinct, but any
    // two writes landing on the same millisecond produced the *same* file and
    // the second silently overwrote the first.
    const stamp = "2026-05-07T00:00:00.123Z";
    const a = createEmptyArchitectureV2("collision", "A");
    a.project.lastUpdated = stamp;
    a.nodes.push(node("a", "A"));

    const b = createEmptyArchitectureV2("collision", "B");
    b.project.lastUpdated = stamp; // Same millisecond, different content.
    b.nodes.push(node("b", "B"));

    const firstPath = saveSnapshot(tempDir, a);
    const secondPath = saveSnapshot(tempDir, b);

    expect(secondPath).not.toBe(firstPath);

    const firstSnap = readSnapshot(tempDir, firstPath.split(/[/\\]/).pop()!.replace(/\.json$/, ""));
    const secondSnap = readSnapshot(tempDir, secondPath.split(/[/\\]/).pop()!.replace(/\.json$/, ""));

    expect(firstSnap.success && firstSnap.data.services[0].id).toBe("a");
    expect(secondSnap.success && secondSnap.data.services[0].id).toBe("b");
  });

  it("filenames are filesystem-safe and sorted oldest-first", () => {
    const a = createEmptyArchitectureV2("sorted", "First");
    a.project.lastUpdated = "2026-05-01T00:00:00.000Z";
    const b = createEmptyArchitectureV2("sorted", "Second");
    b.project.lastUpdated = "2026-05-09T00:00:00.000Z";

    saveSnapshot(tempDir, a);
    saveSnapshot(tempDir, b);

    const names = listSnapshots(tempDir);
    expect(names).toHaveLength(2);
    expect(names[0] < names[1]).toBe(true);
    for (const name of names) {
      expect(name).not.toContain(":");
      expect(name).not.toContain(".");
    }
  });

  it("a snapshot round-trips and keeps unknown keys", () => {
    const arch = createEmptyArchitectureV2("snap-keys", "Snapshot keys") as ReturnType<
      typeof createEmptyArchitectureV2
    > & { "x-custom"?: string };
    arch["x-custom"] = "preserved in snapshots too";

    const path = saveSnapshot(tempDir, arch);
    const key = path.split(/[/\\]/).pop()!.replace(/\.json$/, "");
    const read = readSnapshot(tempDir, key);

    expect(read.success).toBe(true);
    expect(read.success && (read.data as unknown as Record<string, unknown>)["x-custom"]).toBe(
      "preserved in snapshots too"
    );
  });

  it("does not recurse into snapshots when it prunes", () => {
    const arch = createEmptyArchitectureV2("prune", "Prune me");
    for (let i = 0; i < 20; i += 1) {
      arch.nodes.push(node(`s-${i}`, `S${i}`));
      saveSnapshot(tempDir, arch);
    }

    const historyDir = join(tempDir, ARKIVE_DIR, "history");
    expect(readdirSync(historyDir).filter((f) => f.endsWith(".json")).length).toBeLessThanOrEqual(
      MAX_SNAPSHOTS
    );
  });
});

describe("existing snapshot behaviour is unchanged where it matters", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-snapshot-compat-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writeArchitecture auto-saves exactly one snapshot", () => {
    mkdirSync(join(tempDir, ARKIVE_DIR), { recursive: true });
    expect(writeArchitecture(tempDir, createEmptyArchitectureV2("auto", "Auto")).success).toBe(true);
    expect(readdirSync(join(tempDir, ARKIVE_DIR, "history")).filter((f) => f.endsWith(".json"))).toHaveLength(1);
  });

  it("reports a missing snapshot rather than inventing one", () => {
    expect(readSnapshot(tempDir, "2099-01-01T00-00-00-000Z").success).toBe(false);
  });

  it("returns an empty list for a project that has never written", () => {
    expect(listSnapshots(tempDir)).toEqual([]);
    expect(existsSync(join(tempDir, ARKIVE_DIR, "history"))).toBe(false);
  });

  it("a corrupt snapshot is a read error, not a crash", () => {
    mkdirSync(join(tempDir, ARKIVE_DIR, "history"), { recursive: true });
    writeFileSync(join(tempDir, ARKIVE_DIR, "history", "broken.json"), "{ not json", "utf-8");
    expect(readSnapshot(tempDir, "broken").success).toBe(false);
  });
});
