import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, copyFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import {
  LEGACY_PATHS,
  describeProbeConflict,
  probeBlocksWrite,
  probeDocumentPaths,
} from "../../src/io/legacy-paths.js";
import { ARCHITECTURE_FILENAME, ARKIVE_DIR } from "../../src/io/architecture-file.js";
import { initProject } from "../../src/cli/commands/init.js";

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "62066bc");
const LEGACY_FIXTURE = join(FIXTURE_DIR, "legacy-root-architecture.json");
const ORPHAN_FIXTURE = join(FIXTURE_DIR, "orphan-arkive-architecture.json");

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, "src", "cli", "index.ts");

/** Spawning `npx tsx` costs seconds on Windows; the default 5s is not enough. */
const CLI_TIMEOUT = 60_000;

function runCli(args: string[], cwd = REPO_ROOT): { status: number; output: string } {
  // `npx` is a `.cmd` shim on Windows, so it has to go through a shell.
  const command = `npx tsx "${CLI}" ${args
    .map((a) => (/\s/.test(a) ? `"${a}"` : a))
    .join(" ")}`;

  try {
    const output = execSync(command, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function hashTree(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        entries.push(`${full}\n${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
      }
    }
  };
  walk(root);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

function decisionIds(path: string): string[] {
  const doc = JSON.parse(readFileSync(path, "utf-8")) as { decisions?: { id: string }[] };
  return (doc.decisions ?? []).map((d) => d.id);
}

describe("incident 62066bc — the fixture is the incident", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-62066bc-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("legacy fixture really does hold the four decisions that were destroyed", () => {
    const legacy = JSON.parse(readFileSync(LEGACY_FIXTURE, "utf-8"));
    expect(legacy.services).toHaveLength(7);
    expect(legacy.decisions).toHaveLength(4);
    expect(legacy.dataFlows).toHaveLength(3);
    expect(legacy.decisions.map((d: { id: string }) => d.id)).toEqual([
      "d1",
      "dec-002",
      "dec-003",
      "dec-004",
    ]);
  });

  it("the scaffold really does hold none of them", () => {
    const orphan = JSON.parse(readFileSync(ORPHAN_FIXTURE, "utf-8"));
    expect(orphan.services).toHaveLength(3);
    expect(orphan.decisions).toHaveLength(0);
    expect(orphan.dataFlows).toHaveLength(0);
  });

  it("every registered legacy path is a known historical location, not the live one", () => {
    for (const entry of LEGACY_PATHS) {
      expect(entry.relativePath).not.toBe(`${ARKIVE_DIR}/${ARCHITECTURE_FILENAME}`);
      expect(entry.versions).toBeTruthy();
      expect(entry.reason).toBeTruthy();
    }
  });

  it("the live document path is NOT registered as a legacy path", () => {
    // This is the build-time guard ADR-0006 asked for: a path constant that
    // moves must arrive here, and a constant that has not moved must not.
    expect(LEGACY_PATHS.map((e) => e.relativePath)).not.toContain(ARCHITECTURE_FILENAME + "x");
    expect(LEGACY_PATHS.map((e) => e.relativePath)).toContain(ARCHITECTURE_FILENAME);
  });
});

describe("migration detection — refusing, not scaffolding", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-probe-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports 'fresh' for an empty directory", () => {
    const probe = probeDocumentPaths(tempDir);
    expect(probe.status).toBe("fresh");
    expect(probeBlocksWrite(probe)).toBe(false);
  });

  it("reports 'current' when only the live document exists", () => {
    mkdirSync(join(tempDir, ARKIVE_DIR), { recursive: true });
    copyFileSync(ORPHAN_FIXTURE, join(tempDir, ARKIVE_DIR, ARCHITECTURE_FILENAME));

    const probe = probeDocumentPaths(tempDir);
    expect(probe.status).toBe("current");
    expect(probeBlocksWrite(probe)).toBe(false);
  });

  it("reports 'legacy-only' for a directory holding only the pre-migration document", () => {
    copyFileSync(LEGACY_FIXTURE, join(tempDir, ARCHITECTURE_FILENAME));

    const probe = probeDocumentPaths(tempDir);
    expect(probe.status).toBe("legacy-only");
    expect(probeBlocksWrite(probe)).toBe(true);
  });

  it("reports 'ambiguous' for the exact 62066bc state: both files, nothing warning", () => {
    copyFileSync(LEGACY_FIXTURE, join(tempDir, ARCHITECTURE_FILENAME));
    mkdirSync(join(tempDir, ARKIVE_DIR), { recursive: true });
    copyFileSync(ORPHAN_FIXTURE, join(tempDir, ARKIVE_DIR, ARCHITECTURE_FILENAME));

    const probe = probeDocumentPaths(tempDir);
    expect(probe.status).toBe("ambiguous");
    expect(probeBlocksWrite(probe)).toBe(true);
  });

  it("counts what is in each document, because a refusal has to be specific", () => {
    copyFileSync(LEGACY_FIXTURE, join(tempDir, ARCHITECTURE_FILENAME));
    mkdirSync(join(tempDir, ARKIVE_DIR), { recursive: true });
    copyFileSync(ORPHAN_FIXTURE, join(tempDir, ARKIVE_DIR, ARCHITECTURE_FILENAME));

    const probe = probeDocumentPaths(tempDir);
    expect(probe.legacy[0].counts).toMatchObject({ services: 7, decisions: 4, dataFlows: 3 });
    expect(probe.current?.counts).toMatchObject({ services: 3, decisions: 0, dataFlows: 0 });
  });

  it("survives a malformed legacy document instead of crashing on the error path", () => {
    writeFileSync(join(tempDir, ARCHITECTURE_FILENAME), "{ this is not json", "utf-8");

    const probe = probeDocumentPaths(tempDir);
    expect(probe.status).toBe("legacy-only");
    expect(probe.legacy[0].counts).toBeNull();
    expect(probe.legacy[0].error).toBeTruthy();
    expect(describeProbeConflict(probe)).toContain(ARCHITECTURE_FILENAME);
  });

  it("names both paths and both counts when documents are ambiguous", () => {
    copyFileSync(LEGACY_FIXTURE, join(tempDir, ARCHITECTURE_FILENAME));
    mkdirSync(join(tempDir, ARKIVE_DIR), { recursive: true });
    copyFileSync(ORPHAN_FIXTURE, join(tempDir, ARKIVE_DIR, ARCHITECTURE_FILENAME));

    const message = describeProbeConflict(probeDocumentPaths(tempDir));

    expect(message).toContain(ARCHITECTURE_FILENAME);
    expect(message).toContain(`${ARKIVE_DIR}/${ARCHITECTURE_FILENAME}`);
    expect(message).toContain("7 services, 6 connections, 4 decisions, 3 dataFlows, 4 history");
    expect(message).toContain("3 services, 2 connections, 0 decisions, 0 dataFlows, 6 history");
    // Ambiguous, not lost — so no "live only here" alarm, just both counts.
    expect(message).not.toContain("live only here");
  });

  it("says outright that the decisions are only in the legacy file when it is alone", () => {
    copyFileSync(LEGACY_FIXTURE, join(tempDir, ARCHITECTURE_FILENAME));

    const message = describeProbeConflict(probeDocumentPaths(tempDir));

    expect(message).toContain("4 recorded decision(s) live only here");
    expect(message).toMatch(/mv |Move the document/i);
  });
});

describe("init refuses over a document it did not write", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-init-refuse-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("regression A — legacy only: does not scaffold, and leaves no arkive/ document", () => {
    copyFileSync(LEGACY_FIXTURE, join(tempDir, ARCHITECTURE_FILENAME));
    const before = hashTree(tempDir);

    const exit = runCli(["init", "--dir", tempDir, "--skip-mcp", "--skip-skills"]);

    expect(exit.status).not.toBe(0);
    expect(existsSync(join(tempDir, ARKIVE_DIR, ARCHITECTURE_FILENAME))).toBe(false);
    // The real document is untouched, and the four decisions are still in it.
    expect(decisionIds(join(tempDir, ARCHITECTURE_FILENAME))).toEqual([
      "d1",
      "dec-002",
      "dec-003",
      "dec-004",
    ]);
    expect(hashTree(tempDir)).toBe(before);
  }, CLI_TIMEOUT);

  it("regression A — legacy only: the refusal names where the decisions went", () => {
    copyFileSync(LEGACY_FIXTURE, join(tempDir, ARCHITECTURE_FILENAME));

    const exit = runCli(["init", "--dir", tempDir, "--skip-mcp", "--skip-skills"]);

    expect(exit.output).toContain("architecture.json");
    expect(exit.output).toContain("4 recorded decision(s) live only here");
    expect(exit.output).toMatch(/mv |Move the document/i);
  }, CLI_TIMEOUT);

  it("regression B — both files present: refuses, and modifies neither", () => {
    copyFileSync(LEGACY_FIXTURE, join(tempDir, ARCHITECTURE_FILENAME));
    mkdirSync(join(tempDir, ARKIVE_DIR), { recursive: true });
    copyFileSync(ORPHAN_FIXTURE, join(tempDir, ARKIVE_DIR, ARCHITECTURE_FILENAME));
    const before = hashTree(tempDir);

    const exit = runCli(["init", "--dir", tempDir, "--skip-mcp", "--skip-skills"]);

    expect(exit.status).not.toBe(0);
    expect(exit.output).toMatch(/more than one path/i);
    // Byte-for-byte: the incident's core failure was a *write* next to the real
    // document, so the assertion is that no write happened at all.
    expect(hashTree(tempDir)).toBe(before);
  }, CLI_TIMEOUT);

  it("regression B — the count diff names both documents so the user can choose", () => {
    copyFileSync(LEGACY_FIXTURE, join(tempDir, ARCHITECTURE_FILENAME));
    mkdirSync(join(tempDir, ARKIVE_DIR), { recursive: true });
    copyFileSync(ORPHAN_FIXTURE, join(tempDir, ARKIVE_DIR, ARCHITECTURE_FILENAME));

    const exit = runCli(["init", "--dir", tempDir, "--skip-mcp", "--skip-skills"]);

    expect(exit.output).toContain("current path");
    expect(exit.output).toContain("previous path");
    expect(exit.output).toContain("4 decisions");
    expect(exit.output).toContain("0 decisions");
  }, CLI_TIMEOUT);

  it("regression D — the legacy document still validates and still round-trips intact", () => {
    // Property form of the incident: whatever happens around the document, the
    // counts on disk must not move.
    copyFileSync(LEGACY_FIXTURE, join(tempDir, ARCHITECTURE_FILENAME));

    const countBefore = (() => {
      const doc = JSON.parse(readFileSync(join(tempDir, ARCHITECTURE_FILENAME), "utf-8"));
      return [
        doc.services.length,
        doc.connections.length,
        doc.decisions.length,
        doc.dataFlows.length,
        doc.history.length,
      ];
    })();

    runCli(["init", "--dir", tempDir, "--skip-mcp", "--skip-skills"]);

    const doc = JSON.parse(readFileSync(join(tempDir, ARCHITECTURE_FILENAME), "utf-8"));
    expect([doc.services.length, doc.connections.length, doc.decisions.length, doc.dataFlows.length, doc.history.length]).toEqual(countBefore);
  }, CLI_TIMEOUT);
});

describe("init on a healthy project still works", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-init-ok-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("scaffolds normally when no document exists anywhere", () => {
    const exit = runCli(["init", "--dir", tempDir, "--skip-mcp", "--skip-skills"]);

    expect(exit.status).toBe(0);
    expect(existsSync(join(tempDir, ARKIVE_DIR, ARCHITECTURE_FILENAME))).toBe(true);
  }, CLI_TIMEOUT);

  it("re-running init over its own scaffold changes nothing it owns", () => {
    // Scoped to arkive/'s own output on purpose. `injectArkiveBlock`
    // (src/cli/commands/inject.ts, not ours) appends a trailing newline on every
    // run, so CLAUDE.md/AGENTS.md are not byte-stable — a real defect reported
    // as a follow-up. The document must be, or the counts would drift.
    runCli(["init", "--dir", tempDir, "--skip-mcp", "--skip-skills"]);

    const arkiveDir = join(tempDir, ARKIVE_DIR);
    const hashArkive = (): string => hashTree(arkiveDir);
    const firstDocument = readFileSync(join(arkiveDir, ARCHITECTURE_FILENAME), "utf-8");
    const firstHistory = (JSON.parse(firstDocument) as { history: unknown[] }).history.length;
    const before = hashArkive();

    const second = runCli(["init", "--dir", tempDir, "--skip-mcp", "--skip-skills"]);

    expect(second.status).toBe(0);
    expect(readFileSync(join(arkiveDir, ARCHITECTURE_FILENAME), "utf-8")).toBe(firstDocument);
    expect((JSON.parse(firstDocument) as { history: unknown[] }).history).toHaveLength(firstHistory);
    expect(hashArkive()).toBe(before);
  }, CLI_TIMEOUT);

  it("initProject() throws nothing and writes a valid document when called directly", () => {
    // The programmatic entry point shares the probe with the CLI.
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    try {
      initProject({ dir: tempDir, name: "direct", skipMcp: true, skipSkills: true });
    } finally {
      console.log = original;
    }
    expect(existsSync(join(tempDir, ARKIVE_DIR, ARCHITECTURE_FILENAME))).toBe(true);
  });
});
