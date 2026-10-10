import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scanProject,
  loadGitignore,
  globToRegExp,
  SCAN_MAX_FILES,
  SKIP_DIRECTORIES,
} from "../../src/analysis/scanner.js";

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
    write("src/b.py", `import requests`);
    write("src/c.rb", `require 'json'`);

    const scan = scanProject(tempDir);
    // The Python and Ruby files are discovered, recognised as source, and
    // honestly reported as not analysed. A polyglot repo is exactly where a
    // detector's silence is most expensive.
    expect(scan.filesScanned).toBe(1);
    expect(scan.filesUnreadable).toBe(2);
    expect(scan.parseCoverage).toBeCloseTo(1 / 3, 5);
    expect(scan.truncated).toBe(false);
    expect(scan.scanNotes.join(" ")).toMatch(/not JavaScript\/TypeScript/);
  });

  it("never reports 0 files as a healthy scan", () => {
    // A manifest and no source at all. Coverage is 1 of nothing, which reads as
    // clean — so `filesScanned` and the note are what make it legible.
    const scan = scanProject(tempDir);
    expect(scan.filesScanned).toBe(0);
    expect(scan.parseCoverage).toBe(1);
    expect(scan.scanNotes.join(" ")).toMatch(/no JavaScript or TypeScript source files/);
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