import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  saveSnapshot,
  listSnapshots,
  readSnapshot,
  writeArchitecture,
  ARKIVE_DIR,
} from "../../src/io/architecture-file.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";

describe("history snapshots", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-snap-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("saves a snapshot to arkive/history/ with a safe timestamp filename", () => {
    const arch = createEmptyArchitecture("snap-test", "Snap test");
    const snapshotPath = saveSnapshot(tempDir, arch);

    expect(snapshotPath).toContain(join(ARKIVE_DIR, "history"));
    expect(snapshotPath).toMatch(/\.json$/);
    // Filename should not contain colons (filesystem-safe)
    const filename = snapshotPath.split(/[/\\]/).pop()!;
    expect(filename).not.toContain(":");

    const onDisk = JSON.parse(readFileSync(snapshotPath, "utf-8"));
    expect(onDisk.project.name).toBe("snap-test");
  });

  it("listSnapshots returns sorted timestamps", async () => {
    const arch1 = createEmptyArchitecture("snap1", "First");
    saveSnapshot(tempDir, arch1);
    await new Promise((r) => setTimeout(r, 50));

    const arch2 = createEmptyArchitecture("snap2", "Second");
    arch2.project.lastUpdated = new Date(Date.now() + 1000).toISOString();
    saveSnapshot(tempDir, arch2);

    const snapshots = listSnapshots(tempDir);
    expect(snapshots.length).toBe(2);
    // Should be sorted oldest first
    expect(snapshots[0] < snapshots[1]).toBe(true);
  });

  it("readSnapshot returns architecture data for a given timestamp", () => {
    const arch = createEmptyArchitecture("read-snap", "Read snap");
    saveSnapshot(tempDir, arch);

    const timestamps = listSnapshots(tempDir);
    expect(timestamps.length).toBe(1);

    const result = readSnapshot(tempDir, timestamps[0]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.project.name).toBe("read-snap");
    }
  });

  it("readSnapshot returns error for non-existent timestamp", () => {
    const result = readSnapshot(tempDir, "2099-01-01T00-00-00.000Z");
    expect(result.success).toBe(false);
  });

  it("writeArchitecture auto-saves a snapshot", () => {
    const arkiveDir = join(tempDir, ARKIVE_DIR);
    mkdirSync(arkiveDir, { recursive: true });

    const arch = createEmptyArchitecture("auto-snap", "Auto");
    writeArchitecture(tempDir, arch);

    const historyDir = join(arkiveDir, "history");
    const files = readdirSync(historyDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.json$/);
  });
});
