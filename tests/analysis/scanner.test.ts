import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scanProject,
  loadGitignore,
  globToRegExp,
  withinFilters,
  SCAN_MAX_FILES,
  SKIP_DIRECTORIES,
} from "../../src/analysis/scanner.js";
import { createRegistry, DEFAULT_EXTRACTORS } from "../../src/analysis/extractors/registry.js";

/**
 * Scanner honesty.
 *
 * `src/analysis/scanner.ts` used to call `scanImports(join(dir, "src"))` and
 * nothing else. A project laid out as `lib/`, `app/`, `packages/` or
 * `services/` therefore produced `imports: []`, every downstream rule found
 * nothing to complain about, and `arkive reconcile` printed **"in sync"** on a
 * document it had never examined.
 *
 * That is the worst failure mode a drift detector has. It does not look broken;
 * it looks *right*, and it is trusted precisely because it is quiet. ADR-0002
 * already named it: "The scanner's `src` assumption becomes a correctness bug".
 *
 * These tests pin the replacement: a real walk, and a scan that reports on its
 * own coverage so silence can be read correctly.
 */

describe("the scanner walks the repository, not a guessed directory", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-scan-"));
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      "utf-8"
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function write(relPath: string, content: string): void {
    const full = join(tempDir, ...relPath.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }

  it("finds imports under src/", () => {
    write("src/a.ts", `import express from "express";\nimport { z } from "zod";\nimport "./local.js";`);
    expect(scanProject(tempDir).imports.sort()).toEqual(["express", "zod"]);
  });

  it("finds imports under lib/ — the exact case that reported a clean bill of health", () => {
    write("lib/index.ts", `import express from "express";`);
    const scan = scanProject(tempDir);

    expect(scan.imports).toEqual(["express"]);
    expect(scan.roots).toContain("lib");
    expect(scan.parseCoverage).toBe(1);
    expect(scan.filesScanned).toBeGreaterThan(0);
  });

  it("finds imports under app/, packages/ and services/ too", () => {
    write("app/main.tsx", `import React from "react";`);
    write("packages/core/index.js", `const pg = require("pg");`);
    write("services/api/handler.ts", `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";`);

    const scan = scanProject(tempDir);
    expect(scan.imports.sort()).toEqual([
      "@modelcontextprotocol/sdk",
      "pg",
      "react",
    ]);
    expect(scan.roots.sort()).toEqual(["app", "packages", "services"]);
  });

  it("finds imports at the repository root", () => {
    write("vite.config.ts", `import { defineConfig } from "vite";`);
    expect(scanProject(tempDir).imports).toEqual(["vite"]);
  });

  it("finds imports in nested directories arbitrarily deep", () => {
    write("a/b/c/d/e/deep.ts", `import express from "express";`);
    expect(scanProject(tempDir).imports).toEqual(["express"]);
  });

  it("skips node_modules, dist, build, vendor and .git unconditionally", () => {
    expect([...SKIP_DIRECTORIES].sort()).toEqual([
      ".git",
      "build",
      "dist",
      "node_modules",
      "vendor",
    ]);

    for (const skipped of SKIP_DIRECTORIES) {
      write(`${skipped}/evil.ts`, `import "never-seen-${skipped.replace(/\W/g, "")}";`);
    }
    write("src/real.ts", `import express from "express";`);

    const scan = scanProject(tempDir);
    expect(scan.imports).toEqual(["express"]);
    // And they were skipped, not counted as unreadable: they are out of scope by
    // design, so they must not drag coverage down into a false alarm.
    expect(scan.filesUnreadable).toBe(0);
    expect(scan.parseCoverage).toBe(1);
  });

  it("honours .gitignore", () => {
    write(".gitignore", "generated/\n*.gen.ts\n");
    write("generated/api.ts", `import "from-generated";`);
    write("src/types.gen.ts", `import "from-generated";`);
    write("src/real.ts", `import express from "express";`);

    const scan = scanProject(tempDir);
    expect(scan.imports).toEqual(["express"]);
  });

  it("reports coverage honestly when a file cannot be read", () => {
    write("src/a.ts", `import express from "express";`);
    write("src/b.rb", `require 'json'`);
    write("src/c.java", `import java.util.List;`);

    const scan = scanProject(tempDir);
    // Both files are discovered, recognised as source, and honestly reported as
    // not analysed. A polyglot repo is exactly where a detector's silence is
    // most expensive, and the note names the extensions so the reader knows
    // *which* half of the repository was skipped rather than being told only
    // that some of it was.
    expect(scan.filesScanned).toBe(1);
    expect(scan.filesUnreadable).toBe(2);
    expect(scan.parseCoverage).toBeCloseTo(1 / 3, 5);
    expect(scan.truncated).toBe(false);
    expect(scan.scanNotes.join(" ")).toMatch(/no extractor/i);
    expect(scan.unsupported.map((u) => u.extension).sort()).toEqual([".java", ".rb"]);
  });

  it("derives Python and Go as first-class languages, not as unreadable", () => {
    write("src/index.ts", `export const x = 1;`);
    write("pkg/__init__.py", "");
    write("pkg/thing.py", `import os\nfrom .other import helper\nimport requests\n`);
    write("pkg/other.py", `def helper():\n    pass\n`);
    write("src/main.go", `package main\n\nimport (\n\t"fmt"\n\n\t"example.com/app/internal/store"\n)\n\nfunc main() { fmt.Println(store.Get()) }\n`);
    write("src/internal/store/store.go", `package store\n\nfunc Get() string { return "" }\n`);

    const scan = scanProject(tempDir);

    // All three languages are read, not counted as gaps.
    expect(scan.parseCoverage).toBe(1);
    expect(scan.filesUnreadable).toBe(0);
    expect(Object.keys(scan.byLanguage).sort()).toEqual(["go", "python", "ts-js"]);

    // The npm package set is unchanged by a Python import of `requests` — see
    // the note on `ScanResult.imports`; a PyPI package reported as an
    // undeclared JavaScript dependency would be a new false positive replacing
    // an old false negative.
    expect(scan.imports).toEqual([]);

    const python = scan.files.find((f) => f.path === "pkg/thing.py");
    expect(python?.imports.map((i) => i.specifier).sort()).toEqual([
      ".other", "os", "requests",
    ]);
    const go = scan.files.find((f) => f.path === "src/main.go");
    expect(go?.imports.map((i) => i.specifier).sort()).toEqual([
      "example.com/app/internal/store",
      "fmt",
    ]);
  });

  it("never reports 0 files as a healthy scan", () => {
    // A manifest and no source at all. Coverage is 1 of nothing, which reads as
    // clean — so `filesScanned` and the note are what make it legible.
    const scan = scanProject(tempDir);
    expect(scan.filesScanned).toBe(0);
    expect(scan.parseCoverage).toBe(1);
    expect(scan.scanNotes.join(" ")).toMatch(/no analysable source files were found/);
  });

  it("says so when an extractor opened a file but could not read it", () => {
    // An unterminated template literal: everything after it was never searched,
    // so "no imports found" would be a lie. This is the extractor-level version
    // of the bug the whole file exists to prevent, and it must lower coverage
    // rather than pass silently.
    write("src/broken.ts", "const a = `never closed\nimport express from 'express';\n");

    const scan = scanProject(tempDir);
    expect(scan.filesScanned).toBe(0);
    expect(scan.filesUnreadable).toBe(1);
    expect(scan.parseCoverage).toBe(0);
    expect(scan.scanNotes.join(" ")).toMatch(/not fully read/i);
    expect(scan.byLanguage["ts-js"]?.incomplete).toBe(1);
  });

  it("survives an extractor that throws", () => {
    const exploding = {
      id: "exploding",
      language: "Exploding",
      ecosystem: "",
      extensions: [".boom"],
      extract: () => {
        throw new Error("parser gave up");
      },
    };
    write("src/a.ts", `import express from "express";`);
    write("src/b.boom", `anything`);

    // The default registry *plus* the exploding one, so the TypeScript file is
    // still readable and the test measures the throw, not a missing language.
    const scan = scanProject(tempDir, {
      registry: createRegistry([...DEFAULT_EXTRACTORS, exploding]),
    });

    // The file the other extractor could read is still read; the throw is
    // reported rather than propagating out of the scan and losing the run.
    expect(scan.filesScanned).toBe(1);
    expect(scan.filesUnreadable).toBe(1);
    expect(scan.parseCoverage).toBeCloseTo(0.5, 5);
    expect(scan.scanNotes.join(" ")).toMatch(/extractor "exploding" failed on src\/b\.boom/);
  });

  it("does not follow symlinks out of the tree", () => {
    const outside = mkdtempSync(join(tmpdir(), "arkive-outside-"));
    try {
      writeFileSync(join(outside, "secret.ts"), `import "must-not-appear";`, "utf-8");
      symlinkSync(outside, join(tempDir, "linked"), "dir");
      write("src/real.ts", `import express from "express";`);

      const scan = scanProject(tempDir);
      expect(scan.imports).toEqual(["express"]);
      expect(scan.scanNotes.join(" ")).toMatch(/symlinked directory linked/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reports the roots and byte counts a caller needs to judge the scan", () => {
    write("src/a.ts", `import express from "express";`);
    write("test/b.ts", `import vitest from "vitest";`);

    const scan = scanProject(tempDir);
    expect(scan.roots.sort()).toEqual(["src", "test"]);
    expect(scan.filesScanned).toBe(2);
    expect(scan.bytesScanned).toBeGreaterThan(0);
    expect(scan.hasPackageJson).toBe(true);
  });

  it("still ignores relative imports and node: builtins", () => {
    write("src/a.ts", `import "./relative.js";\nimport "../up.js";\nimport fs from "node:fs";\nimport path from "path";`);
    expect(scanProject(tempDir).imports).toEqual([]);
  });

  it("still normalizes scoped packages to their full name", () => {
    write("src/a.ts", `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";`);
    expect(scanProject(tempDir).imports).toEqual(["@modelcontextprotocol/sdk"]);
  });

  it("returns empty dependencies when there is no package.json", () => {
    const bare = mkdtempSync(join(tmpdir(), "arkive-bare-"));
    try {
      const scan = scanProject(bare);
      expect(scan.hasPackageJson).toBe(false);
      expect(scan.dependencies).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("exposes its cap, and the cap is a real bound", () => {
    expect(SCAN_MAX_FILES).toBeGreaterThan(0);
    expect(Number.isFinite(SCAN_MAX_FILES)).toBe(true);
  });
});

/**
 * The acceptance criterion that caused this rewrite, stated as a test.
 *
 * "Given a fixture repo with a `src/`, a fixture with `lib/`, and a fixture with
 * `packages/`, all three produce equivalent graph coverage." The bug was that
 * the scanner hardcoded `join(dir, "src")`, so the second and third produced an
 * empty dependency set and `reconcile` printed "in sync" on them.
 *
 * The three fixtures below hold byte-identical module graphs under different
 * directory names. Coverage must be identical. Anything less and the layout is
 * still being guessed at, whatever the default is.
 */
describe("equivalent coverage regardless of where the source lives", () => {
  /** One temp dir per layout: scanning the same tree four times would accumulate. */
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function freshRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "arkive-layout-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      "utf-8"
    );
    return dir;
  }

  function write(dir: string, relPath: string, content: string): void {
    const full = join(dir, ...relPath.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }

  /** The same four-module project, written under a different root each time. */
  function seed(dir: string, root: string): void {
    write(dir, `${root}/index.ts`, `import express from "express";\nimport { render } from "./render.js";\n`);
    write(dir, `${root}/render.ts`, `import express from "express";\nimport { helper } from "./util";\n`);
    write(dir, `${root}/util.ts`, `import { config } from "./config.js";\nexport const helper = () => config;\n`);
    write(dir, `${root}/config.ts`, `export const config = { port: 3000 };\n`);
  }

  it("src/, lib/, packages/ and a nested service all scan to the same coverage", () => {
    const layouts = ["src", "lib", "packages/core", "services/api/src"];
    const results = layouts.map((root) => {
      const dir = freshRepo();
      seed(dir, root);
      return scanProject(dir);
    });

    for (const [index, scan] of results.entries()) {
      expect(scan.parseCoverage, `${layouts[index]} coverage`).toBe(1);
      expect(scan.filesScanned, `${layouts[index]} files`).toBe(4);
      expect(scan.filesUnreadable, `${layouts[index]} unreadable`).toBe(0);
      expect(scan.imports, `${layouts[index]} imports`).toEqual(["express"]);
      expect(scan.roots, `${layouts[index]} roots`).toContain(
        layouts[index].split("/")[0]
      );
    }

    // And the strongest statement available: the dependency set is identical,
    // not merely non-empty. The old scanner returned `[]` for two of these.
    const unique = new Set(results.map((scan) => scan.imports.join(",")));
    expect(unique.size).toBe(1);
  });

  it("reports the per-language breakdown a polyglot repository needs", () => {
    const dir = freshRepo();
    write(dir, "src/index.ts", `import express from "express";`);
    write(dir, "pkg/thing.py", `import os\nfrom . import other\n`);
    write(dir, "pkg/other.py", `x = 1\n`);
    write(dir, "cmd/main.go", `package main\nimport "fmt"\nfunc main() { fmt.Println() }\n`);

    const scan = scanProject(dir);

    expect(scan.byLanguage["ts-js"]).toEqual({ files: 1, imports: 1, incomplete: 0 });
    expect(scan.byLanguage.python).toEqual({ files: 2, imports: 2, incomplete: 0 });
    expect(scan.byLanguage.go).toEqual({ files: 1, imports: 1, incomplete: 0 });
    expect(scan.parseCoverage).toBe(1);
  });
});

describe("--include and --exclude narrow the scan, and say they did", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-filter-"));
    writeFileSync(join(tempDir, "package.json"), "{}", "utf-8");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function write(relPath: string, content: string): void {
    const full = join(tempDir, ...relPath.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }

  it("include restricts the walk and states the restriction", () => {
    write("src/a.ts", `import express from "express";`);
    write("scripts/build.ts", `import express from "express";`);

    const all = scanProject(tempDir);
    expect(all.filesScanned).toBe(2);

    const scoped = scanProject(tempDir, { include: ["src"] });
    expect(scoped.filesScanned).toBe(1);
    expect(scoped.files.map((file) => file.path)).toEqual(["src/a.ts"]);
    // The narrowing is in `scanNotes`, because a scan that quietly covered half
    // the repository would report 100% and mean nothing by it.
    expect(scoped.scanNotes.join(" ")).toMatch(/restricted to src/);
  });

  it("exclude drops a path without counting it against coverage", () => {
    write("src/a.ts", `import express from "express";`);
    write("src/a.test.ts", `import vitest from "vitest";`);

    const scoped = scanProject(tempDir, { exclude: ["src/a.test.ts"] });
    expect(scoped.files.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(scoped.parseCoverage).toBe(1);
    expect(scoped.scanNotes.join(" ")).toMatch(/excludes src\/a\.test\.ts/);
  });

  it("matches on a path boundary, so `src` does not swallow `srcgen`", () => {
    expect(withinFilters("src/a.ts", ["src"], [])).toBe(true);
    expect(withinFilters("srcgen/a.ts", ["src"], [])).toBe(false);
    expect(withinFilters("src/nested/deep/a.ts", ["src"], [])).toBe(true);
    expect(withinFilters("src/a.ts", [], ["src/nested"])).toBe(true);
    // A trailing slash names the same directory and excludes the same files.
    expect(withinFilters("src/a.ts", [], ["src/"])).toBe(false);
    expect(withinFilters("srcgen/a.ts", [], ["src/"])).toBe(true);
    expect(withinFilters("anything/at/all.ts", [], [])).toBe(true);
  });
});

describe("gitignore matching", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-ignore-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function matcher(content: string) {
    writeFileSync(join(tempDir, ".gitignore"), content, "utf-8");
    return loadGitignore(tempDir);
  }

  it("an absent .gitignore ignores nothing", () => {
    const ignore = loadGitignore(tempDir);
    expect(ignore("anything/at/all.ts", false)).toBe(false);
  });

  it("matches a bare name at any depth", () => {
    const ignore = matcher("node_modules\n");
    expect(ignore("node_modules", true)).toBe(true);
    expect(ignore("packages/a/node_modules", true)).toBe(true);
    expect(ignore("src/node_modules_helper", true)).toBe(false);
  });

  it("honours anchoring", () => {
    const ignore = matcher("/build\n");
    expect(ignore("build", true)).toBe(true);
    expect(ignore("packages/build", true)).toBe(false);
  });

  it("supports directory-only patterns", () => {
    const ignore = matcher("dist/\n");
    expect(ignore("dist", true)).toBe(true);
    expect(ignore("dist", false)).toBe(false);
  });

  it("supports negation, last match wins", () => {
    const ignore = matcher("*.log\n!important.log\n");
    expect(ignore("important.log", false)).toBe(false);
    expect(ignore("a.log", false)).toBe(true);
  });

  it("supports ** and single-segment globs", () => {
    const ignore = matcher("packages/**/generated\n*.gen.ts\n");
    expect(ignore("packages/a/b/generated", true)).toBe(true);
    expect(ignore("src/types.gen.ts", false)).toBe(true);
    expect(ignore("src/types.ts", false)).toBe(false);
  });

  it("ignores comments and blank lines", () => {
    const ignore = matcher("# a comment\n\n   \nreal/\n");
    expect(ignore("# a comment", true)).toBe(false);
    expect(ignore("real", true)).toBe(true);
  });

  it("a later rule overrides an earlier one", () => {
    const ignore = matcher("*\n!src\n");
    expect(ignore("vendor", true)).toBe(true);
    expect(ignore("src", true)).toBe(false);
  });

  it("globToRegExp anchors and scopes as documented", () => {
    expect(globToRegExp("node_modules").test("a/node_modules")).toBe(true);
    expect(globToRegExp("/build").test("a/build")).toBe(false);
    expect(globToRegExp("a?c").test("abc")).toBe(true);
    expect(globToRegExp("a?c").test("a/c")).toBe(false);
    expect(globToRegExp("x.y").test("xzy")).toBe(false);
  });
});