import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  saveSnapshot,
  listSnapshots,
  readSnapshot,
  writeArchitecture,
  ARKIVE_DIR,
} from "../../src/io/architecture-file.js";
import { createEmptyArchitectureV2 } from "../../src/schema/validate-graph.js";

describe("history snapshots", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-snap-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("saves a snapshot to arkive/history/ with a safe timestamp filename", () => {
    const arch = createEmptyArchitectureV2("snap-test", "Snap test");
    const snapshotPath = saveSnapshot(tempDir, arch);

    expect(snapshotPath).toContain(join(ARKIVE_DIR, "history"));
    expect(snapshotPath).toMatch(/\.json$/);
    // Filename should not contain colons (filesystem-safe)
    const filename = snapshotPath.split(/[/\\]/).pop()!;
    expect(filename).not.toContain(":");

    const onDisk = JSON.parse(readFileSync(snapshotPath, "utf-8"));
    expect(onDisk.project.name).toBe("snap-test");
    expect(onDisk.schemaVersion).toBe(2);
  });

  it("listSnapshots returns sorted timestamps", async () => {
    const arch1 = createEmptyArchitectureV2("snap1", "First");
    saveSnapshot(tempDir, arch1);
    await new Promise((r) => setTimeout(r, 50));
    const arch2 = createEmptyArchitectureV2("snap2", "Second");
    arch2.project.lastUpdated = new Date(Date.now() + 1000).toISOString();
    saveSnapshot(tempDir, arch2);

    const snapshots = listSnapshots(tempDir);
    expect(snapshots.length).toBe(2);
    // Should be sorted oldest first
    expect(snapshots[0] < snapshots[1]).toBe(true);
  });

  it("readSnapshot returns architecture data for a given timestamp", () => {
    const arch = createEmptyArchitectureV2("read-snap", "Read snap");
    saveSnapshot(tempDir, arch);

    const timestamps = listSnapshots(tempDir);
    expect(timestamps).toHaveLength(1);

    const result = readSnapshot(tempDir, timestamps[0]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.project.name).toBe("read-snap");
      expect(result.data.nodes).toEqual([]);
    }
  });

  it("readSnapshot returns error for non-existent timestamp", () => {
    const result = readSnapshot(tempDir, "2099-01-01T00-00-00-000Z");
    expect(result.success).toBe(false);
  });

  it("reads a v1 snapshot through the migration path", () => {
    // Snapshots written before v2 exist in the wild. A read path that only
    // understood v2 would make every one of them unreadable the day it shipped.
    mkdirSync(join(tempDir, ARKIVE_DIR, "history"), { recursive: true });
    const legacy = {
      version: "1.0.0",
      project: {
        name: "old-snap",
        description: "written before v2",
        created: "2026-05-05T00:00:00.000Z",
        lastUpdated: "2026-05-05T00:00:00.000Z",
      },
      stack: {
        language: ["TypeScript"],
        runtime: [],
        framework: [],
        database: [],
        infrastructure: [],
      },
      services: [
        { id: "api", name: "API", type: "backend", technology: "Express", description: "d", dependencies: [] },
      ],
      connections: [],
      decisions: [],
      dataFlows: [],
      history: [{ timestamp: "2026-05-05T00:00:00.000Z", action: "initial_scaffold", summary: "created" }],
    };
    // The filename has to look like one so `listSnapshots`/`readSnapshot` agree.
    writeFileSync(
      join(tempDir, ARKIVE_DIR, "history", "2026-05-05T00-00-00-000Z--deadbeefcafe.json"),
      `${JSON.stringify(legacy, null, 2)}\n`,
      "utf-8"
    );

    const result = readSnapshot(tempDir, "2026-05-05T00-00-00-000Z--deadbeefcafe");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.schemaVersion).toBe(2);
    expect(result.data.version).toBe("1.0.0");
    expect(result.data.services.map((s) => s.id)).toEqual(["api"]);
    expect(result.data.services[0].type).toBe("backend");
  });

  it("writeArchitecture auto-saves a snapshot", () => {
    const arkiveDir = join(tempDir, ARKIVE_DIR);
    mkdirSync(arkiveDir, { recursive: true });

    const arch = createEmptyArchitectureV2("auto-snap", "Auto");
    writeArchitecture(tempDir, arch);

    const historyDir = join(arkiveDir, "history");
    const files = readdirSync(historyDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.json$/);
  });
});