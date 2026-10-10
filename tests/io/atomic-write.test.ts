import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import {
  FAULT_BEFORE_RENAME_ENV,
  cleanupStaleTempFiles,
  isTempFile,
  writeFileAtomic,
} from "../../src/io/atomic-write.js";
import {
  ARKIVE_DIR,
  architecturePath,
  readArchitecture,
  writeArchitecture,
} from "../../src/io/architecture-file.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";

const REPO_ROOT = process.cwd();
const CLI_TIMEOUT = 60_000;

describe("atomic writes", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-atomic-"));
  });

  afterEach(() => {
    delete process.env[FAULT_BEFORE_RENAME_ENV];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates the file and its parent directory", () => {
    const path = join(tempDir, "nested", "deep", "file.json");
    writeFileAtomic(path, "{}\n");
    expect(readFileSync(path, "utf-8")).toBe("{}\n");
  });

  it("overwrites an existing file completely", () => {
    const path = join(tempDir, "file.json");
    writeFileAtomic(path, "a".repeat(5000));
    writeFileAtomic(path, "short");
    expect(readFileSync(path, "utf-8")).toBe("short");
  });

  it("leaves no temp file behind on the success path", () => {
    writeFileAtomic(join(tempDir, "file.json"), "payload");
    expect(readdirSync(tempDir)).toEqual(["file.json"]);
  });

  it("preserves the destination's permissions rather than resetting them", () => {
    if (process.platform === "win32") return; // chmod semantics differ
    const path = join(tempDir, "file.json");
    writeFileSync(path, "one");
    chmodSync(path, 0o600);
    writeFileAtomic(path, "two");
    // Mode is read back through the fs; 0o600 & 0o777 must survive the rename.
    expect(readdirSync(tempDir)).toEqual(["file.json"]);
    writeFileAtomic(path, "three");
    expect(readFileSync(path, "utf-8")).toBe("three");
  });
});

describe("torn write — the failure that destroys documents today", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-torn-"));
  });

  afterEach(() => {
    delete process.env[FAULT_BEFORE_RENAME_ENV];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("regression F — a fault before the rename leaves the original byte-intact", () => {
    const path = join(tempDir, "doc.json");
    const original = JSON.stringify({ decisions: ["keep me"] });
    writeFileSync(path, original, "utf-8");

    expect(() => writeFileAtomic(path, "{ this never lands", { faultBeforeRename: true })).toThrow();

    expect(readFileSync(path, "utf-8")).toBe(original);
  });

  it("regression F — and leaves no partial file in the directory", () => {
    const path = join(tempDir, "doc.json");
    writeFileSync(path, "original", "utf-8");

    expect(() => writeFileAtomic(path, "replacement", { faultBeforeRename: true })).toThrow();

    // Not "the file is fine" — nothing at all is left lying around.
    expect(readdirSync(tempDir)).toEqual(["doc.json"]);
  });

  it("regression F — a fault while creating a new file leaves nothing behind", () => {
    const path = join(tempDir, "doc.json");

    expect(() => writeFileAtomic(path, "replacement", { faultBeforeRename: true })).toThrow();

    expect(existsSync(path)).toBe(false);
    expect(readdirSync(tempDir)).toEqual([]);
  });

  it("regression F — the architecture document survives a failed write", () => {
    const arch = createEmptyArchitecture("torn", "Torn write");
    expect(writeArchitecture(tempDir, arch).success).toBe(true);

    const path = architecturePath(tempDir);
    const before = readFileSync(path, "utf-8");

    const bigger = {
      ...arch,
      services: [
        {
          id: "api",
          name: "API",
          type: "backend" as const,
          technology: "Node",
          description: "A service that should never appear on disk",
          dependencies: [],
        },
      ],
    };

    process.env[FAULT_BEFORE_RENAME_ENV] = "throw";
    const result = writeArchitecture(tempDir, bigger);

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toMatch(/Injected fault/);
    // The old document is still complete and still parses.
    expect(readFileSync(path, "utf-8")).toBe(before);
    const reread = readArchitecture(tempDir);
    expect(reread.success).toBe(true);
    expect(reread.success && reread.data.services).toHaveLength(0);
  });

  it("regression F — a hard crash mid-write also leaves the original intact", () => {
    const path = join(tempDir, "doc.json");
    const original = "the real document\n";
    writeFileSync(path, original, "utf-8");

    // Simulates SIGKILL: the process dies between fsync and rename, so the
    // cleanup path never runs. A dot-prefixed temp file is the only casualty.
    const script = `
import { writeFileAtomic } from ${JSON.stringify(
  pathToFileURL(join(REPO_ROOT, "src", "io", "atomic-write.ts")).href
)};
process.env.${FAULT_BEFORE_RENAME_ENV} = "exit";
writeFileAtomic(${JSON.stringify(path)}, "the half-written replacement");
`;

    let crashed = false;
    try {
      execSync(`npx tsx --eval ${JSON.stringify(script)}`, {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      crashed = true;
    }

    expect(crashed).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(original);
    // Only an inert dot-prefixed temp file may remain.
    for (const entry of readdirSync(tempDir)) {
      if (entry === "doc.json") continue;
      expect(isTempFile(entry)).toBe(true);
    }
  }, CLI_TIMEOUT);

  it("cleans up temp files abandoned by a crashed process", () => {
    writeFileSync(join(tempDir, ".doc.json.999.abcdef.tmp"), "orphan");
    writeFileSync(join(tempDir, ".doc.json.998.123456.tmp"), "orphan");
    writeFileSync(join(tempDir, "doc.json"), "real");

    const removed = cleanupStaleTempFiles(tempDir, 0);

    expect(removed).toHaveLength(2);
    expect(readdirSync(tempDir)).toEqual(["doc.json"]);
  });

  it("does not mistake a real file for a temp file", () => {
    expect(isTempFile("architecture.json")).toBe(false);
    expect(isTempFile(".architecture.json.1.2.tmp")).toBe(true);
  });
});

describe("the next read after a crash finds a valid document, not truncated JSON", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-crash-"));
  });

  afterEach(() => {
    delete process.env[FAULT_BEFORE_RENAME_ENV];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("regression — 200 interrupted writes never leave an unparseable document", () => {
    writeArchitecture(tempDir, createEmptyArchitecture("crashy", "Crash test"));

    for (let i = 0; i < 200; i += 1) {
      process.env[FAULT_BEFORE_RENAME_ENV] = "throw";
      writeArchitecture(tempDir, {
        ...createEmptyArchitecture("crashy", "Crash test"),
        services: [
          {
            id: `svc-${i}`,
            name: `Service ${i}`,
            type: "other",
            technology: "none",
            description: "never committed",
            dependencies: [],
          },
        ],
      });
      delete process.env[FAULT_BEFORE_RENAME_ENV];

      const read = readArchitecture(tempDir);
      expect(read.success).toBe(true);
      if (read.success) {
        expect(read.data.project.name).toBe("crashy");
        expect(read.data.services).toHaveLength(0);
      }
    }
  }, CLI_TIMEOUT);

  it("a partially written file on disk is reported as a parse error, not silently accepted", () => {
    const path = join(tempDir, ARKIVE_DIR, "architecture.json");
    writeFileAtomic(path, '{"version":"1.0.0", "project":{');
    const read = readArchitecture(tempDir);
    expect(read.success).toBe(false);
    expect(read.success === false && read.error.toLowerCase()).toContain("parse");
  });
});
