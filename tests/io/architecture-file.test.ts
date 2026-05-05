import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readArchitecture,
  writeArchitecture,
  ARCHITECTURE_FILENAME,
} from "../../src/io/architecture-file.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";

describe("architecture file I/O", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "archlearn-io-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exports the canonical filename", () => {
    expect(ARCHITECTURE_FILENAME).toBe("architecture.json");
  });

  it("reads and validates a well-formed architecture.json", () => {
    const arch = createEmptyArchitecture("read-test", "Read test");
    writeFileSync(
      join(tempDir, ARCHITECTURE_FILENAME),
      JSON.stringify(arch, null, 2),
      "utf-8"
    );

    const result = readArchitecture(tempDir);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.project.name).toBe("read-test");
    }
  });

  it("returns a not-found error when architecture.json is missing", () => {
    const result = readArchitecture(tempDir);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not found");
    }
  });

  it("returns a parse error when architecture.json is malformed JSON", () => {
    writeFileSync(join(tempDir, ARCHITECTURE_FILENAME), "{ not json", "utf-8");
    const result = readArchitecture(tempDir);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.toLowerCase()).toContain("parse");
    }
  });

  it("returns a validation error when architecture.json fails schema", () => {
    writeFileSync(
      join(tempDir, ARCHITECTURE_FILENAME),
      JSON.stringify({ version: "1.0.0" }),
      "utf-8"
    );
    const result = readArchitecture(tempDir);
    expect(result.success).toBe(false);
  });

  it("writes a valid architecture and bumps lastUpdated", async () => {
    const arch = createEmptyArchitecture("write-test", "Write test");
    const originalUpdated = arch.project.lastUpdated;
    await new Promise((r) => setTimeout(r, 10));

    const result = writeArchitecture(tempDir, arch);
    expect(result.success).toBe(true);

    const onDisk = JSON.parse(
      readFileSync(join(tempDir, ARCHITECTURE_FILENAME), "utf-8")
    );
    expect(onDisk.project.name).toBe("write-test");
    expect(onDisk.project.lastUpdated).not.toBe(originalUpdated);
    expect(new Date(onDisk.project.lastUpdated).getTime()).toBeGreaterThan(
      new Date(originalUpdated).getTime()
    );
  });

  it("refuses to write an invalid architecture", () => {
    const arch = createEmptyArchitecture("bad-write", "Bad");
    arch.connections.push({
      from: "ghost",
      to: "phantom",
      protocol: "HTTP",
      description: "Invalid",
    });
    const result = writeArchitecture(tempDir, arch);
    expect(result.success).toBe(false);
    expect(existsSync(join(tempDir, ARCHITECTURE_FILENAME))).toBe(false);
  });
});
