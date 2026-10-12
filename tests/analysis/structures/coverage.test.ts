import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveModules } from "../../../src/analysis/derive.js";
import { deriveFromScan } from "../../../src/analysis/derive.js";
import { scanProject } from "../../../src/analysis/scanner.js";
import { detectDrift } from "../../../src/analysis/drift.js";
import { mergeDerived } from "../../../src/analysis/derive.js";
import { createEmptyArchitectureV2 } from "../../../src/schema/validate-graph.js";
import { createStructureRegistry, DEFAULT_STRUCTURE_EXTRACTORS, defaultStructureRegistry } from "../../../src/analysis/structures/registry.js";
import { tsStructureExtractor } from "../../../src/analysis/structures/ts-types.js";
import { zodStructureExtractor } from "../../../src/analysis/structures/zod.js";
import type {
  StructureContext,
  StructureExtractor,
  StructureResult,
} from "../../../src/analysis/structures/types.js";

/**
 * The honesty contract, and "a new format is one file".
 *
 * ## The rule being tested
 *
 * `docs/issues/0006-data-structure-extraction.md` risk section: *"Extraction
 * quality varies enormously by codebase, and a poor extractor is worse than
 * none because it produces confident wrong structure. Ship it as best-effort
 * with explicit coverage reporting — same honesty rule as 0005."*
 *
 * And the instruction this layer exists under: **a partial parse must never look
 * like a complete one.** A structure extractor that silently skips a file it
 * cannot parse produces a graph with a hole shaped exactly like a graph with no
 * such coupling — and unlike the import hole, nobody has ever looked for this
 * one, because until now nothing claimed to fill it.
 *
 * So:
 * 1. structure coverage **folds into** the headline rather than sitting beside
 *    it, because a caller handed two numbers displays the flattering one;
 * 2. a file with no structure extractor is counted and named, not ignored;
 * 3. a file an extractor claimed and failed on is counted against coverage;
 * 4. a configuration that turns the pass off says so.
 */

function write(dir: string, relPath: string, content: string): void {
  const full = join(dir, ...relPath.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

describe("structure coverage folds into the headline rather than sitting beside it", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-cov-"));
    writeFileSync(join(tempDir, "package.json"), "{}", "utf-8");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports 100% only when both passes read everything", () => {
    write(tempDir, "src/a.ts", "export interface A {\n  id: string;\n}\n");

    const result = deriveModules(tempDir);

    expect(result.importCoverage).toBe(1);
    expect(result.structureCoverage).toBe(1);
    expect(result.coverage).toBe(1);
  });

  it("drops the headline when the structure pass cannot read a file", () => {
    // The imports parse perfectly. One file's declarations do not. Reporting
    // 100% would describe a graph that has a hole in it.
    write(tempDir, "src/ok.ts", "export interface Ok {\n  id: string;\n}\n");
    write(tempDir, "src/bad.ts", "export interface Bad {\n  bio: 'unterminated\n");

    const result = deriveModules(tempDir);

    expect(result.importCoverage).toBe(1);
    expect(result.structureCoverage).toBeCloseTo(0.5, 5);
    expect(result.coverage).toBeCloseTo(0.5, 5);
  });

  it("drops the headline when a file has no structure extractor, and names it", () => {
    write(tempDir, "src/a.ts", "export interface A {\n  id: string;\n}\n");
    write(tempDir, "pkg/thing.py", "import os\n");

    const result = deriveModules(tempDir);

    // A `.py` file is in the module graph and absent from the shape graph. The
    // number says so rather than reporting the TypeScript half's 100%.
    expect(result.structureCoverage).toBe(1);
    expect(result.coverage).toBe(1);
    expect(result.structures.unsupported).toEqual([{ extension: ".py", files: 1 }]);
    expect(result.notes.join(" ")).toMatch(/no data-structure extractor for/i);
    expect(result.notes.join(" ")).toMatch(/\.py/);
  });

  it("says so when nothing at all could be read for shapes", () => {
    write(tempDir, "pkg/thing.py", "import os\n");
    write(tempDir, "cmd/main.go", "package main\nimport \"fmt\"\n");

    const result = deriveModules(tempDir);

    expect(result.nodes.filter((node) => node.kind === "datastructure")).toEqual([]);
    expect(result.notes.join(" ")).toMatch(/module graph with no shapes/i);
  });

  it("reports an extractor that throws rather than treating it as 'no shapes here'", () => {
    write(tempDir, "src/a.ts", "export interface A {\n  id: string;\n}\n");

    const exploding: StructureExtractor = {
      id: "exploding",
      format: "Exploding",
      extensions: [".ts"],
      extract(): StructureResult {
        throw new Error("boom");
      },
    };

    const result = deriveFromScan(scanProject(tempDir), {
      structureRegistry: createStructureRegistry([tsStructureExtractor, exploding]),
    });

    expect(result.structureCoverage).toBe(0);
    expect(result.coverage).toBe(0);
    expect(result.notes.join(" ")).toMatch(/exploding.*failed on src\/a\.ts/i);
    expect(result.notes.join(" ")).toMatch(/boom/);
  });

  it("counts an extractor that gives up, and keeps what it did find", () => {
    write(
      tempDir,
      "src/a.ts",
      "export interface Good {\n  id: string;\n}\nexport interface Bad {\n  bio: 'unterminated\n"
    );

    const result = deriveModules(tempDir);

    // Partial evidence with an honest coverage number beats no evidence.
    expect(result.structures.filesIncomplete).toBe(1);
    expect(result.coverage).toBeCloseTo(0, 5);
    expect(result.nodes.some((node) => node.id.endsWith("::Good"))).toBe(true);
  });

  it("makes an unresolved name reference visible rather than silent", () => {
    write(tempDir, "src/a.ts", "export interface Shared {\n  id: string;\n}\n");
    write(tempDir, "src/b.ts", "export interface Shared {\n  other: string;\n}\n");
    write(tempDir, "src/c.ts", "export const use = (x: Shared): string => x.id;\n");

    const result = deriveModules(tempDir);

    expect(result.structures.unresolved.map((entry) => entry.name)).toContain("Shared");
    expect(result.notes.join(" ")).toMatch(/could not be attributed/i);
  });

  it("does not accuse an authored datastructure when this run derived none", () => {
    // ADR-0002:116 — the orphan verdict only fires when there is evidence to be
    // absent. A repository with no extractable declarations has no opinion.
    write(tempDir, "pkg/thing.py", "import os\n");

    const document = createEmptyArchitectureV2("orphan", "Orphan");
    document.nodes = [
      {
        id: "datastructure:src/legacy.ts::Handwritten",
        kind: "datastructure",
        name: "Handwritten",
        summary: "Written by a human before any extractor existed.",
        path: "src/legacy.ts",
        provenance: { derived: false, authoredBy: "human" },
      },
    ];

    const merged = mergeDerived(document, deriveModules(tempDir));

    expect(merged.orphanedAuthored).toEqual([]);
    expect(merged.nodes.some((node) => node.id === "datastructure:src/legacy.ts::Handwritten")).toBe(
      true
    );
  });

  it("reports an authored datastructure this run cannot reproduce", () => {
    // The other half of the same rule: once a rule emits datastructure nodes,
    // an authored one the run cannot reproduce *is* contradicted by evidence.
    write(tempDir, "src/a.ts", "export interface Present {\n  id: string;\n}\n");

    const document = createEmptyArchitectureV2("orphan", "Orphan");
    document.nodes = [
      {
        id: "datastructure:src/gone.ts::Vanished",
        kind: "datastructure",
        name: "Vanished",
        summary: "A shape someone described by hand and has since deleted.",
        path: "src/gone.ts",
        provenance: { derived: false, authoredBy: "human", reviewedAt: "2026-01-01T00:00:00.000Z" },
      },
    ];

    const merged = mergeDerived(document, deriveModules(tempDir));

    expect(merged.orphanedAuthored.map((orphan) => orphan.id)).toEqual([
      "datastructure:src/gone.ts::Vanished",
    ]);
    // Reported, never deleted.
    expect(merged.nodes.some((node) => node.id === "datastructure:src/gone.ts::Vanished")).toBe(true);
  });

  it("keeps the drift report's own verdict independent of the structure pass", () => {
    // `incomplete-scan` is about whether the *scan* covered the repository. The
    // structure pass is a second question, and conflating them would make every
    // polyglot project report "inconclusive" for a reason that has nothing to do
    // with whether the document matches the code.
    write(tempDir, "src/a.ts", "export interface A {\n  id: string;\n}\n");

    const scan = scanProject(tempDir);
    const report = detectDrift(
      createEmptyArchitectureV2("d", "D") as never,
      scan,
      deriveFromScan(scan)
    );

    expect(report.conclusive).toBe(true);
  });

  it("turning the pass off is a note, never a silent default", () => {
    write(tempDir, "src/a.ts", "export interface A {\n  id: string;\n}\n");

    const result = deriveModules(tempDir, { structures: false });

    expect(result.nodes.filter((node) => node.kind === "datastructure")).toEqual([]);
    // The number does not claim to describe shapes it never looked for…
    expect(result.coverage).toBe(1);
    // …and the note says exactly what it does describe. `reconcile` prints
    // `notes` on every path, including "in sync".
    expect(result.notes.join(" ")).toMatch(/disabled by arkive\.config\.json/i);
    expect(result.notes.join(" ")).toMatch(/no shapes/i);
  });

  it("reads the switch from arkive.config.json, not only from the option", () => {
    // The config is the documented way to turn it off. An option that only
    // worked when passed programmatically would leave the documented switch
    // inert, and an inert switch is worse than none.
    write(tempDir, "arkive.config.json", JSON.stringify({ structures: false }));
    write(tempDir, "src/a.ts", "export interface A {\n  id: string;\n}\n");

    const result = deriveModules(tempDir);

    expect(result.nodes.filter((node) => node.kind === "datastructure")).toEqual([]);
    expect(result.notes.join(" ")).toMatch(/disabled by arkive\.config\.json/i);
  });

  it("lets an explicit option override the config file", () => {
    write(tempDir, "arkive.config.json", JSON.stringify({ structures: false }));
    write(tempDir, "src/a.ts", "export interface A {\n  id: string;\n}\n");

    const result = deriveModules(tempDir, { structures: true });

    expect(result.nodes.filter((node) => node.kind === "datastructure")).toHaveLength(1);
  });

  it("ignores a non-boolean 'structures' rather than coercing it", () => {
    // `"false"` is a truthy string. Coercing it would turn the extractor *on*
    // for a user who asked for the opposite, and the only symptom would be a
    // coverage number that never moves.
    write(
      tempDir,
      "arkive.config.json",
      JSON.stringify({ structures: "false" })
    );
    write(tempDir, "src/a.ts", "export interface A {\n  id: string;\n}\n");

    const result = deriveModules(tempDir);

    expect(result.nodes.filter((node) => node.kind === "datastructure")).toHaveLength(1);
    expect(result.notes.join(" ")).toMatch(/"structures" must be true or false/i);
  });
});

describe("adding a format is one file", () => {
  /** A format nobody has written, in one object literal. */
  const sqlDdlExtractor: StructureExtractor = {
    id: "sql-ddl",
    format: "SQL DDL",
    extensions: [".sql"],
    extract(ctx: StructureContext): StructureResult {
      const structures = [];
      const pattern = /CREATE\s+TABLE\s+([A-Za-z_][\w.]*)\s*\(([\s\S]*?)\)\s*;/gi;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(ctx.source)) !== null) {
        structures.push({
          name: match[1],
          path: ctx.path,
          extractorId: sqlDdlExtractor.id,
          form: "sql-table",
          line: ctx.source.slice(0, match.index).split("\n").length,
          exported: true,
          fields: match[2]
            .split(",")
            .map((column) => /^\s*([a-z_][\w]*)\s+([a-z][\w ]*)/i.exec(column))
            .filter((column): column is RegExpExecArray => column !== null)
            .map((column) => ({
              name: column[1],
              type: column[2].trim().replace(/\s+not\s+null$/i, "").toLowerCase(),
              optional: false,
              line: ctx.source.slice(0, match!.index).split("\n").length,
            })),
        });
      }
      return { structures, usages: [], transformations: [], complete: true };
    },
  };

  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-format-"));
    writeFileSync(join(tempDir, "package.json"), "{}", "utf-8");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs a format registered at runtime with nothing else changed", () => {
    write(
      tempDir,
      "db/schema.sql",
      "CREATE TABLE services (\n  id VARCHAR(64) NOT NULL,\n  port INTEGER NOT NULL\n);\n"
    );

    // The only line this feature requires.
    const structureRegistry = createStructureRegistry([
      ...DEFAULT_STRUCTURE_EXTRACTORS,
      sqlDdlExtractor,
    ]);

    const result = deriveFromScan(scanProject(tempDir), { structureRegistry });

    const node = result.nodes.find((candidate) => candidate.kind === "datastructure");
    expect(node?.id).toBe("datastructure:db/schema.sql::services");
    expect(node?.provenance.derived && node.provenance.rule).toBe("sql-ddl/datastructure-node");
    const fields = (node as unknown as { fields: Array<{ name: string; type: string }> }).fields;
    expect(fields).toEqual([
      { name: "id", type: "varchar", optional: false, line: 1 },
      { name: "port", type: "integer", optional: false, line: 1 },
    ]);
  });

  it("names its own vocabulary so a new format is discoverable", () => {
    const registry = createStructureRegistry([...DEFAULT_STRUCTURE_EXTRACTORS, sqlDdlExtractor]);

    expect(registry.ids).toEqual(["ts-types", "zod", "sql-ddl"]);
    expect(registry.formats).toEqual(["TypeScript declarations", "Zod schemas", "SQL DDL"]);
  });

  it("lets several extractors claim one extension, which is the point", () => {
    // The inverse of the import registry, which throws. A `.ts` file declares
    // interfaces *and* Zod schemas, and both are shapes.
    expect(() =>
      createStructureRegistry([tsStructureExtractor, zodStructureExtractor])
    ).not.toThrow();
    expect(defaultStructureRegistry.forPath("src/a.ts")).toHaveLength(2);
    expect(defaultStructureRegistry.forPath("main.go")).toEqual([]);
  });
});