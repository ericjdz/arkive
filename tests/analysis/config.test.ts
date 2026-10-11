import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, stripJsonComments, MAX_FILES_CEILING } from "../../src/analysis/config.js";
import { scanProject } from "../../src/analysis/scanner.js";
import { deriveModules } from "../../src/analysis/derive.js";

/**
 * `arkive.config.json`.
 *
 * The config exists because the default cannot be right for everyone: `src`,
 * `lib`, `app`, `packages/<pkg>/src` and `services/<svc>` are all real layouts
 * and none of them is inferable from a repository nobody has opened. So the
 * default is the whole tree and the config narrows it.
 *
 * The rule the whole file turns on is that **narrowing is reported**. A config
 * that quietly reduced coverage would reintroduce, one step sideways, the exact
 * bug the scan was rewritten to end: a number that looks complete and does not
 * describe the repository.
 */
describe("arkive.config.json", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-config-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function write(relPath: string, content: string): void {
    const full = join(tempDir, ...relPath.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }

  it("restricts the walk and states the restriction", () => {
    write("package.json", "{}");
    write("arkive.config.json", JSON.stringify({ include: ["src"] }));
    write("src/a.ts", `import express from "express";`);
    write("scripts/build.ts", `import express from "express";`);

    const scan = scanProject(tempDir);
    expect(scan.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(scan.parseCoverage).toBe(1);
    expect(scan.scanNotes.join(" ")).toMatch(/restricted to src/);
  });

  it("excludes and skips, and reports both", () => {
    write("package.json", "{}");
    write("arkive.config.json", JSON.stringify({ exclude: ["fixtures"], skip: ["__mocks__"] }));
    write("src/a.ts", `export const a = 1;`);
    write("fixtures/x.ts", `export const x = 1;`);
    write("__mocks__/y.ts", `export const y = 1;`);

    const scan = scanProject(tempDir);
    expect(scan.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(scan.scanNotes.join(" ")).toMatch(/excludes fixtures/);
  });

  it("search roots find Python packages under src/", () => {
    write("arkive.config.json", JSON.stringify({ searchRoots: ["", "src"] }));
    write("src/pkg/__init__.py", "");
    write("src/pkg/mod.py", `import os\nfrom .other import helper\n`);
    write("src/pkg/other.py", `helper = 1\n`);

    const result = deriveModules(tempDir);
    expect(result.unresolved).toEqual([]);
    expect(result.edges.some((e) => e.to === "module:src/pkg/other.py")).toBe(true);
  });

  it("extra aliases apply alongside tsconfig's own", () => {
    // A webpack or vite alias lives in a bundler config this product
    // deliberately does not parse, so `arkive.config.json` is where it goes.
    write("tsconfig.json", `{
      // tsconfig carries comments in the wild.
      "compilerOptions": { "paths": { "@/*": ["src/*"] } },
    }`);
    // `third_party`, not `vendor`: `vendor` is in `SKIP_DIRECTORIES` and never
    // walked, so an alias pointing into it could not resolve by construction.
    write("arkive.config.json", JSON.stringify({ aliases: { "~lib": ["third_party/lib"] } }));
    write("src/a.ts", `import { x } from "@/util";\nimport { y } from "~lib/y";\n`);
    write("src/util.ts", `export const x = 1;`);
    write("third_party/lib/y.ts", `export const y = 1;`);

    const result = deriveModules(tempDir);
    expect(result.unresolved).toEqual([]);
    expect(result.edges.some((e) => e.to === "module:src/util.ts")).toBe(true);
    expect(result.edges.some((e) => e.to === "module:third_party/lib/y.ts")).toBe(true);
  });

  it("an alias into a skipped directory does not resolve, and says so", () => {
    // `vendor` is never walked. An alias pointing into it therefore produces an
    // unresolved import rather than a silently missing edge, which is the
    // difference between "you configured this" and "it just did not work".
    write("arkive.config.json", JSON.stringify({ aliases: { "~v": ["vendor"] } }));
    write("src/a.ts", `import { z } from "~v/z";`);

    const result = deriveModules(tempDir);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].specifier).toBe("~v/z");
    expect(result.unresolved[0].candidates).toContain("vendor/z.ts");
  });

  it("a malformed config is reported, not silently ignored", () => {
    // A broken config that produced an empty scan would be indistinguishable
    // from a project with no code — the one outcome this product cannot
    // afford to produce silently.
    write("arkive.config.json", "{ not json");
    write("src/a.ts", `export const a = 1;`);

    const loaded = loadConfig(tempDir);
    expect(loaded.notes.join(" ")).toMatch(/could not be parsed/);
    // And the scan still runs.
    expect(scanProject(tempDir).filesScanned).toBe(1);
  });

  it("a config field of the wrong type is reported and dropped", () => {
    write("arkive.config.json", JSON.stringify({ include: "src", maxFiles: -1 }));
    const loaded = loadConfig(tempDir);
    expect(loaded.notes.join(" ")).toMatch(/"include" must be an array of strings/);
    expect(loaded.notes.join(" ")).toMatch(/"maxFiles" must be a positive number/);
    expect(loaded.config.include).toBeUndefined();
    expect(loaded.config.maxFiles).toBeUndefined();
  });

  it("clamps a cap that would make the scan unable to finish", () => {
    write("arkive.config.json", JSON.stringify({ maxFiles: MAX_FILES_CEILING * 10 }));
    const loaded = loadConfig(tempDir);
    expect(loaded.config.maxFiles).toBe(MAX_FILES_CEILING);
    expect(loaded.notes.join(" ")).toMatch(/exceeds the .* ceiling/);
  });

  it("reports where the config was read from", () => {
    write("arkive.config.json", JSON.stringify({ include: ["src"] }));
    expect(loadConfig(tempDir).source).toBe(join(tempDir, "arkive.config.json"));
  });

  it("no config is not an error", () => {
    const loaded = loadConfig(tempDir);
    expect(loaded.source).toBeNull();
    expect(loaded.config).toEqual({});
  });
});

describe("tsconfig.json reading", () => {
  it("strips comments and trailing commas without moving anything", () => {
    const input = `{
      // a line comment
      "a": 1, /* inline */
      "b": [1, 2,],
    }`;
    expect(JSON.parse(stripJsonComments(input))).toEqual({ a: 1, b: [1, 2] });
  });

  it("does not strip comment-like text inside a string", () => {
    const input = `{"url": "https://example.com/x", "note": "/* not a comment */"}`;
    expect(JSON.parse(stripJsonComments(input))).toEqual({
      url: "https://example.com/x",
      note: "/* not a comment */",
    });
  });

  it("a tsconfig it cannot parse produces a note, not a silent empty alias set", () => {
    const dir = mkdtempSync(join(tmpdir(), "arkive-tsconfig-"));
    try {
      writeFileSync(join(dir, "tsconfig.json"), "{ this is not json", "utf-8");
      const loaded = loadConfig(dir);
      expect(loaded.notes.join(" ")).toMatch(/tsconfig\.json could not be parsed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});