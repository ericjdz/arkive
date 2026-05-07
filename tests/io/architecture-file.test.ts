import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readArchitecture,
  writeArchitecture,
  ARCHITECTURE_FILENAME,
  ARKIVE_DIR,
  architecturePath,
  arkiveDirPath,
} from "../../src/io/architecture-file.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";

describe("architecture file I/O", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-io-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exports the canonical filename", () => {
    expect(ARCHITECTURE_FILENAME).toBe("architecture.json");
  });

  it("exports the arkive directory name", () => {
    expect(ARKIVE_DIR).toBe("arkive");
  });

  it("architecturePath resolves under arkive/ subdirectory", () => {
    const result = architecturePath(tempDir);
    expect(result).toBe(join(tempDir, "arkive", "architecture.json"));
  });

  it("arkiveDirPath resolves to arkive/ subdirectory", () => {
    const result = arkiveDirPath(tempDir);
    expect(result).toBe(join(tempDir, "arkive"));
  });

  it("reads and validates a well-formed architecture.json", () => {
    const arkiveDir = join(tempDir, "arkive");
    mkdirSync(arkiveDir, { recursive: true });
    const arch = createEmptyArchitecture("read-test", "Read test");
    writeFileSync(
      join(arkiveDir, ARCHITECTURE_FILENAME),
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
    const arkiveDir = join(tempDir, "arkive");
    mkdirSync(arkiveDir, { recursive: true });
    writeFileSync(join(arkiveDir, ARCHITECTURE_FILENAME), "{ not json", "utf-8");
    const result = readArchitecture(tempDir);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.toLowerCase()).toContain("parse");
    }
  });

  it("returns a validation error when architecture.json fails schema", () => {
    const arkiveDir = join(tempDir, "arkive");
    mkdirSync(arkiveDir, { recursive: true });
    writeFileSync(
      join(arkiveDir, ARCHITECTURE_FILENAME),
      JSON.stringify({ version: "1.0.0" }),
      "utf-8"
    );
    const result = readArchitecture(tempDir);
    expect(result.success).toBe(false);
  });

  it("writes a valid architecture and bumps lastUpdated", async () => {
    const arkiveDir = join(tempDir, "arkive");
    mkdirSync(arkiveDir, { recursive: true });
    const arch = createEmptyArchitecture("write-test", "Write test");
    const originalUpdated = arch.project.lastUpdated;
    await new Promise((r) => setTimeout(r, 10));

    const result = writeArchitecture(tempDir, arch);
    expect(result.success).toBe(true);

    const onDisk = JSON.parse(
      readFileSync(join(arkiveDir, ARCHITECTURE_FILENAME), "utf-8")
    );
    expect(onDisk.project.name).toBe("write-test");
    expect(onDisk.project.lastUpdated).not.toBe(originalUpdated);
    expect(new Date(onDisk.project.lastUpdated).getTime()).toBeGreaterThan(
      new Date(originalUpdated).getTime()
    );
  });

  it("refuses to write an invalid architecture", () => {
    const arkiveDir = join(tempDir, "arkive");
    mkdirSync(arkiveDir, { recursive: true });
    const arch = createEmptyArchitecture("bad-write", "Bad");
    arch.connections.push({
      from: "ghost",
      to: "phantom",
      protocol: "HTTP",
      description: "Invalid",
    });
    const result = writeArchitecture(tempDir, arch);
    expect(result.success).toBe(false);
    expect(existsSync(join(arkiveDir, ARCHITECTURE_FILENAME))).toBe(false);
  });
});
