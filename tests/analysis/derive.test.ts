import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveModules, mergeDerived, deriveFromScan } from "../../src/analysis/derive.js";
import type { DerivationResult } from "../../src/analysis/derive.js";
import { scanProject } from "../../src/analysis/scanner.js";
import { detectDrift } from "../../src/analysis/drift.js";
import { createEmptyArchitectureV2 } from "../../src/schema/validate-graph.js";
import type { GraphNode } from "../../src/schema/graph.js";

/**
 * The derivation engine.
 *
 * `docs/issues/0005-module-derivation.md` is the issue that makes the graph
 * trustworthy: the graph is derived first, authored second, because structure is
 * a fact and facts should not be transcribed by an LLM (ADR-0002:46-51).
 *
 * The tests below are written around three failure modes rather than three
 * features, because the features are easy and the failure modes are what ship:
 *
 * 1. **Fabricated evidence.** An edge citing a line that does not import
 *    anything is worse than a missing edge, because it is indistinguishable
 *    from a correct one. Every assertion here checks the cited line, not just
 *    the edge's existence.
 * 2. **A layout assumption creeping back in.** `src/` was the original bug. The
 *    equivalence tests build byte-identical projects under four different roots.
 * 3. **A derived refresh eating authored work.** If a scan can overwrite
 *    something a human wrote, it cannot run on every commit, and "continuous
 *    reconciliation" (issue 0007) has to become opt-in instead.
 */

function write(dir: string, relPath: string, content: string): void {
  const full = join(dir, ...relPath.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

function nodeIds(nodes: readonly GraphNode[], kind?: string): string[] {
  return nodes
    .filter((node) => kind === undefined || node.kind === kind)
    .map((node) => node.id)
    .sort();
}

function nodeById(result: DerivationResult, id: string): GraphNode {
  const found = result.nodes.find((node) => node.id === id);
  if (found === undefined) throw new Error(`no node ${id} in [${result.nodes.map((n) => n.id).join(", ")}]`);
  return found;
}

/** Read the cited line back out of the fixture. Evidence you cannot open is not evidence. */
function citedLine(dir: string, locator: string): string {
  const at = locator.lastIndexOf(":");
  const path = locator.slice(0, at);
  const line = Number(locator.slice(at + 1));
  const content = readFileSync(join(dir, ...path.split("/")), "utf-8");
  return content.split("\n")[line - 1] ?? "";
}

describe("module nodes carry a path and mandatory provenance", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-derive-"));
    writeFileSync(join(tempDir, "package.json"), "{}", "utf-8");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("emits a module node per source file, with path and rule", () => {
    write(tempDir, "src/index.ts", `import { render } from "./render.js";\n`);
    write(tempDir, "src/render.ts", `export const render = () => null;\n`);

    const result = deriveModules(tempDir);

    expect(nodeIds(result.nodes, "module")).toEqual([
      "module:dir:src",
      "module:src/index.ts",
      "module:src/render.ts",
    ]);

    const index = nodeById(result, "module:src/index.ts");
    expect(index.kind).toBe("module");
    expect(index.path).toBe("src/index.ts");
    // ADR-0002:97-101: derived elements carry `derived`, `rule` and `evidence`.
    // `confidence` is deleted — a self-assessed number is not evidence.
    expect(index.provenance).toEqual({
      derived: true,
      rule: "ts-js/module-node",
      evidence: ["src/index.ts:1"],
    });
    expect(index).not.toHaveProperty("confidence");
  });

  it("every derived element has rule and evidence, and no confidence anywhere", () => {
    write(tempDir, "src/a.ts", `import express from "express";\nimport { b } from "./b.js";\n`);
    write(tempDir, "src/b.ts", `export const b = 1;\n`);

    const result = deriveModules(tempDir);

    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.edges.length).toBeGreaterThan(0);
    for (const node of result.nodes) {
      expect(node.provenance.derived).toBe(true);
      if (!node.provenance.derived) continue;
      expect(node.provenance.rule).toBeTruthy();
      expect(node.provenance.evidence.length).toBeGreaterThan(0);
      expect(JSON.stringify(node)).not.toContain("confidence");
    }
    for (const edge of result.edges) {
      expect(edge.provenance.derived).toBe(true);
      if (!edge.provenance.derived) continue;
      expect(edge.provenance.rule).toBeTruthy();
      expect(edge.provenance.evidence.length).toBeGreaterThan(0);
    }
  });

  it("emits a directory node for every ancestor that contains code", () => {
    write(tempDir, "src/deep/nested/a.ts", `export const a = 1;\n`);

    const result = deriveModules(tempDir);
    expect(nodeIds(result.nodes, "module")).toContain("module:dir:src/deep/nested");
    expect(result.directories).toBe(3);
  });

  it("puts every import site on the edge, not a representative one", () => {
    // ADR-0002:101-103: "Evidence is an array because an import edge between
    // two directories has many sites."
    write(
      tempDir,
      "src/a.ts",
      [
        `import express from "express";`,
        `import { z } from "zod";`,
        `const lazy = () => import("pg");`,
        `// import ghost from "never-scanned";`,
      ].join("\n")
    );

    const result = deriveModules(tempDir);
    const edge = result.edges.find(
      (candidate) =>
        candidate.from === "module:src/a.ts" && candidate.to === "external:npm:express"
    );

    expect(edge).toBeDefined();
    expect(edge?.provenance.derived && edge.provenance.evidence).toEqual(["src/a.ts:1"]);
    expect(edge?.provenance.derived && edge.provenance.rule).toBe("ts-js/import-edge");
  });

  it("evidence points at the line that actually imports", () => {
    write(
      tempDir,
      "src/a.ts",
      [`const x = 1;`, `const y = 2;`, `import express from "express";`].join("\n")
    );

    const result = deriveModules(tempDir);
    const edge = result.edges.find((e) => e.to === "external:npm:express");

    // Not just "a line number exists" — the line, opened, is the import.
    expect(edge?.provenance.derived && edge.provenance.evidence).toEqual(["src/a.ts:3"]);
    expect(citedLine(tempDir, "src/a.ts:3")).toMatch(/import express/);
  });

  it("resolves a .js specifier to the .ts file it names", () => {
    // `./x.js` meaning `./x.ts` is the standard under `moduleResolution:
    // node16`. Without the rewrite every single-file edge in such a project
    // dangles, and a dangling edge is reported as `critical` — so getting this
    // wrong manufactures false alarms rather than merely missing edges.
    write(tempDir, "src/a.ts", `import { x } from "./x.js";\n`);
    write(tempDir, "src/x.ts", `export const x = 1;\n`);

    const result = deriveModules(tempDir);
    expect(result.unresolved).toEqual([]);
    expect(result.edges.some((e) => e.to === "module:src/x.ts")).toBe(true);
  });

  it("resolves an extensionless specifier to an index file", () => {
    write(tempDir, "src/a.ts", `import { x } from "./sub";\n`);
    write(tempDir, "src/sub/index.ts", `export const x = 1;\n`);

    const result = deriveModules(tempDir);
    expect(result.edges.some((e) => e.to === "module:src/sub/index.ts")).toBe(true);
  });

  it("resolves a tsconfig path alias", () => {
    write(
      tempDir,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } })
    );
    write(tempDir, "src/a.ts", `import { x } from "@/util";\n`);
    write(tempDir, "src/util.ts", `export const x = 1;\n`);

    const result = deriveModules(tempDir);
    expect(result.unresolved).toEqual([]);
    expect(result.edges.some((e) => e.to === "module:src/util.ts")).toBe(true);
  });

  it("emits an external node per package, with every site as evidence", () => {
    write(tempDir, "src/a.ts", `import express from "express";\n`);
    write(tempDir, "src/b.ts", `import express from "express";\nimport { Router } from "express";\n`);

    const result = deriveModules(tempDir);
    const external = nodeById(result, "external:npm:express");

    expect(external.kind).toBe("external");
    expect(external.tech).toBe("npm");
    expect(external.provenance.derived && external.provenance.evidence).toEqual([
      "src/a.ts:1",
      "src/b.ts:1",
      "src/b.ts:2",
    ]);
  });

  it("does not turn node builtins into external nodes", () => {
    write(tempDir, "src/a.ts", `import fs from "node:fs";\nimport path from "path";\n`);

    const result = deriveModules(tempDir);
    expect(nodeIds(result.nodes, "external")).toEqual([]);
  });

  it("scopes a Python `requests` and an npm `requests` to different ecosystems", () => {
    write(tempDir, "pkg/thing.py", `import requests\n`);
    write(tempDir, "src/a.ts", `import express from "express";\n`);

    const result = deriveModules(tempDir);
    const external = nodeIds(result.nodes, "external");
    expect(external).toContain("external:pypi:requests");
    expect(nodeById(result, "external:pypi:requests").tech).toBe("pypi");
  });
});

describe("layout equivalence: src/, lib/, packages/ and nested services", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repo(root: string): string {
    const dir = mkdtempSync(join(tmpdir(), "arkive-layout-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      "utf-8"
    );
    write(dir, `${root}/index.ts`, `import express from "express";\nimport { render } from "./render.js";\n`);
    write(dir, `${root}/render.ts`, `import express from "express";\nimport { helper } from "./util";\n`);
    write(dir, `${root}/util.ts`, `import { config } from "./config.js";\nexport const helper = () => config;\n`);
    write(dir, `${root}/config.ts`, `export const config = { port: 3000 };\n`);
    return dir;
  }

  /**
   * The file-level graph, with the layout root stripped.
   *
   * Directory nodes are excluded deliberately: a layout nested three deep
   * genuinely has three ancestor directories where a flat one has one, and
   * asserting they match would be asserting that the tool ignores the tree. The
   * file-level subgraph is the thing that must be layout-independent, and the
   * directory count is asserted separately below.
   */
  function shape(result: DerivationResult, root: string): string {
    const strip = (id: string): string =>
      id
        .replace(`module:dir:${root}`, "<dir>")
        .replace(`module:${root}/`, "")
        .replace(/^module:/, "");
    const files = result.nodes
      .filter((n) => n.kind === "module" && n.path !== root && !n.id.startsWith("module:dir:"))
      .map((n) => strip(n.id))
      .sort();
    const edges = result.edges
      .map((e) => `${strip(e.from)}->${strip(e.to)}`)
      .sort();
    return JSON.stringify({ files, edges });
  }

  it("all four layouts produce an identical file-level graph", () => {
    const layouts = ["src", "lib", "packages/core", "services/api/src"];
    const results = layouts.map((root) => deriveModules(repo(root)));

    const shapes = results.map((result, index) => shape(result, layouts[index]));
    // Printed on failure because the useful information is *how* they differ,
    // and "expected 4 to be 1" does not say which file moved.
    if (new Set(shapes).size !== 1) {
      shapes.forEach((value, index) => console.error(`${layouts[index]}: ${value}`));
    }
    expect(new Set(shapes).size).toBe(1);

    for (const [index, result] of results.entries()) {
      expect(result.coverage, `${layouts[index]} coverage`).toBe(1);
      expect(result.counts.unreadable, `${layouts[index]} unreadable`).toBe(0);
      expect(result.unresolved, `${layouts[index]} unresolved`).toEqual([]);
      // 4 files, plus one directory node per ancestor of the layout root —
      // which is the only count that legitimately differs between layouts.
      const expectedDirectories = layouts[index].split("/").length;
      expect(result.directories, `${layouts[index]} directories`).toBe(expectedDirectories);
      expect(
        result.nodes.filter((n) => n.kind === "module" && !n.id.startsWith("module:dir:")),
        `${layouts[index]} file nodes`
      ).toHaveLength(4);
      expect(
        result.edges.filter(
          (e) =>
            e.to === "external:npm:express" && !e.from.startsWith("module:dir:")
        ).length,
        `${layouts[index]} express edges from files`
      ).toBe(2);
      // Plus one aggregated edge from the directory that holds them — the level
      // a reader working on the area rather than the file traverses.
      expect(
        result.edges.filter((e) => e.to === "external:npm:express").length,
        `${layouts[index]} express edges total`
      ).toBe(3);
    }
  });
});

describe("a deleted module is reported, never dropped and never silent", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-deleted-"));
    writeFileSync(join(tempDir, "package.json"), "{}", "utf-8");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("emits a dangling edge and an unresolved report for a missing module", () => {
    write(tempDir, "src/a.ts", `import { gone } from "./deleted.js";\n`);

    const result = deriveModules(tempDir);

    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].from).toBe("src/a.ts");
    expect(result.unresolved[0].specifier).toBe("./deleted.js");
    expect(result.unresolved[0].line).toBe(1);
    // Every candidate it tried is kept, so a reader can see what was looked for.
    expect(result.unresolved[0].candidates).toContain("src/deleted.js");

    const dangling = result.edges.find((edge) => edge.dangling === true);
    expect(dangling?.from).toBe("module:src/a.ts");
    // ADR-0001:141-145: preserved rather than dropped.
    expect(dangling?.to).toBe("module:src/deleted.ts");
  });

  it("raises `critical` when a derived module cannot be reproduced", () => {
    write(tempDir, "src/a.ts", `export const a = 1;\n`);
    write(tempDir, "src/b.ts", `export const b = 1;\n`);

    const first = deriveModules(tempDir);
    expect(first.nodes.map((n) => n.id)).toContain("module:src/b.ts");

    unlinkSync(join(tempDir, "src", "b.ts"));
    write(tempDir, "src/a.ts", `import { b } from "./b.js";\n`);

    const second = deriveModules(tempDir);
    const document = createEmptyArchitectureV2("deleted", "Deleted module fixture");
    const merged = mergeDerived(document, second);
    document.nodes = merged.nodes;
    document.edges = merged.edges;

    const report = detectDrift(
      document as never,
      { ...scanProject(tempDir), fileIndex: scanProject(tempDir).fileIndex },
      second
    );

    // Two independent critical signals, both real: an import naming a file that
    // is not there, and a derived node the current run cannot reproduce.
    expect(report.warnings.filter((w) => w.kind === "unresolved-import")).toHaveLength(1);
    expect(report.warnings.filter((w) => w.kind === "unresolved-import")[0].severity).toBe("critical");
    expect(report.summary.bySeverity.critical).toBeGreaterThan(0);
  });

  it("tombstones a derived node rather than deleting it", () => {
    write(tempDir, "src/a.ts", `export const a = 1;\n`);
    write(tempDir, "src/b.ts", `export const b = 1;\n`);

    const document = createEmptyArchitectureV2("t", "T");
    document.nodes = mergeDerived(document, deriveModules(tempDir)).nodes;

    unlinkSync(join(tempDir, "src", "b.ts"));
    const after = mergeDerived(document, deriveModules(tempDir));

    const tombstoned = after.nodes.find((node) => node.id === "module:src/b.ts");
    // ADR-0001:129-137 — a soft delete, because edges reference it and only a
    // human can say whether it was a move or a removal.
    expect(tombstoned).toBeDefined();
    expect(tombstoned?.deletedAt).toBeTruthy();
    expect(after.tombstoned).toBe(1);
    // The surviving node is untouched.
    expect(after.nodes.find((n) => n.id === "module:src/a.ts")?.deletedAt).toBeUndefined();
  });
});

describe("the derived / authored split", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-split-"));
    writeFileSync(join(tempDir, "package.json"), "{}", "utf-8");
    write(tempDir, "src/a.ts", `export const a = 1;\n`);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("refreshes derived elements on every scan", () => {
    const first = deriveModules(tempDir);
    const document = createEmptyArchitectureV2("refresh", "Refresh");
    document.nodes = mergeDerived(document, first).nodes;

    write(tempDir, "src/b.ts", `export const b = 2;\n`);
    const second = mergeDerived(document, deriveModules(tempDir));

    expect(second.replaced).toBeGreaterThan(0);
    expect(second.nodes.some((n) => n.id === "module:src/b.ts")).toBe(true);
  });

  it("never overwrites an authored node with a derived one", () => {
    const document = createEmptyArchitectureV2("authored", "Authored");
    document.nodes = [
      {
        id: "module:src/a.ts",
        kind: "module",
        name: "a.ts",
        summary: "Hand-written description of what this module is for.",
        path: "src/a.ts",
        provenance: { derived: false, authoredBy: "human", reviewedAt: "2026-01-01T00:00:00.000Z" },
      },
    ];

    const merged = mergeDerived(document, deriveModules(tempDir));

    const preserved = merged.nodes.find((n) => n.id === "module:src/a.ts");
    expect(preserved?.summary).toBe("Hand-written description of what this module is for.");
    expect(preserved?.provenance.derived).toBe(false);
    expect(merged.preservedAuthored).toBe(1);
  });

  it("never overwrites an agent-authored node either", () => {
    const document = createEmptyArchitectureV2("agent", "Agent");
    document.nodes = [
      {
        id: "module:src/a.ts",
        kind: "module",
        name: "a.ts",
        summary: "Written by an agent, still not overwritten.",
        path: "src/a.ts",
        provenance: { derived: false, authoredBy: "agent" },
      },
    ];

    const merged = mergeDerived(document, deriveModules(tempDir));
    expect(merged.nodes.find((n) => n.id === "module:src/a.ts")?.summary).toBe(
      "Written by an agent, still not overwritten."
    );
  });

  it("carries a human summary across a derived refresh", () => {
    // The human half of a structurally-derived node is `summary` and `owner`.
    // Losing them because a line moved would make the graph unusable for the
    // exact reader it exists to serve.
    const document = createEmptyArchitectureV2("carry", "Carry");
    document.nodes = mergeDerived(document, deriveModules(tempDir)).nodes;
    const target = document.nodes.find((n) => n.id === "module:src/a.ts");
    if (target === undefined) throw new Error("fixture did not derive");
    target.summary = "The thing that does the thing.";
    target.owner = "platform-team";

    write(tempDir, "src/a.ts", `export const a = 1;\nexport const a2 = 2;\n`);
    const merged = mergeDerived(document, deriveModules(tempDir));
    const refreshed = merged.nodes.find((n) => n.id === "module:src/a.ts");

    expect(refreshed?.summary).toBe("The thing that does the thing.");
    expect(refreshed?.owner).toBe("platform-team");
    // ...but the provenance is refreshed, so the evidence describes this run.
    expect(refreshed?.provenance.derived).toBe(true);
  });

  it("leaves authored edges alone when derivation drops the same id", () => {
    write(tempDir, "src/a.ts", `import express from "express";\n`);
    const document = createEmptyArchitectureV2("edges", "Edges");
    document.nodes = mergeDerived(document, deriveModules(tempDir)).nodes;
    document.edges = [
      {
        id: "imports:module:src/a.ts->external:npm:express",
        from: "module:src/a.ts",
        to: "external:npm:express",
        kind: "imports",
        note: "hand-written, load-bearing",
        provenance: { derived: false, authoredBy: "human" },
      },
    ];

    write(tempDir, "src/a.ts", `export const a = 1;\n`);
    const merged = mergeDerived(document, deriveModules(tempDir));

    const edge = merged.edges.find((e) => e.id === "imports:module:src/a.ts->external:npm:express");
    expect(edge?.note).toBe("hand-written, load-bearing");
    expect(edge?.provenance.derived).toBe(false);
  });
});

describe("coverage is restated wherever the graph is consumed", () => {
  it("carries the scan's parse coverage and counts into the result", () => {
    const dir = mkdtempSync(join(tmpdir(), "arkive-cov-"));
    try {
      writeFileSync(join(dir, "package.json"), "{}", "utf-8");
      write(dir, "src/a.ts", `export const a = 1;\n`);
      write(dir, "src/b.rb", `puts 1\n`);

      const scan = scanProject(dir);
      const result = deriveFromScan(scan);

      expect(result.coverage).toBe(scan.parseCoverage);
      expect(result.counts).toEqual({
        parsed: scan.filesScanned,
        unreadable: scan.filesUnreadable,
        truncated: scan.filesTruncated,
      });
      expect(result.coverage).toBeCloseTo(0.5, 5);
      // And the note is carried with the graph, so a caller displaying the
      // graph has the explanation without re-running the scan.
      expect(result.notes.join(" ")).toMatch(/no extractor/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});