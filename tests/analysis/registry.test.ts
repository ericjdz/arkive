import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRegistry, DEFAULT_EXTRACTORS, defaultRegistry } from "../../src/analysis/extractors/registry.js";
import { deriveFromScan } from "../../src/analysis/derive.js";
import { scanProject } from "../../src/analysis/scanner.js";
import type { ExtractedImport, Extractor } from "../../src/analysis/extractors/types.js";

/**
 * Proof, not assertion, that adding a language is one new file.
 *
 * `docs/issues/0005-module-derivation.md` §1 makes this an acceptance criterion
 * and `docs/issues/README.md` records the reasoning: "0005 and 0006 both touch
 * src/analysis/scanner.ts — serialise, or split the file first." A claim like
 * that rots the first time somebody adds an `else if` to a walker, so it is
 * tested instead.
 *
 * The test below registers a language no other code knows about, in one
 * function body, and then runs a complete scan and derivation over a fixture
 * written in it. Nothing else is touched. If the walker had a per-language
 * branch, or if resolution were hard-coded per language, this fails.
 */

/** A language that does not exist, implemented in one function body. */
const exampleScriptExtractor: Extractor = {
  id: "example-script",
  language: "ExampleScript",
  ecosystem: "examplescript",
  extensions: [".exs"],

  extract(ctx) {
    const imports: ExtractedImport[] = [];

    ctx.source.split("\n").forEach((raw, index) => {
      const match = /^\s*(?:use|require)\s+["']([^"']+)["']/.exec(raw);
      if (match === null) return;
      const specifier = match[1];
      imports.push({
        specifier,
        line: index + 1,
        form: "import-from",
        // A relative specifier is a module; anything else is a package. This is
        // the only classification a real extractor has to make, and the graph
        // below depends on it being right.
        target: specifier.includes("/")
          ? { kind: "module", path: specifier }
          : { kind: "package", ecosystem: "examplescript", name: specifier },
      });
    });

    return { imports, complete: true };
  },
};

describe("adding a language is one new file", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-lang-"));
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

  it("a language registered at runtime is scanned and derived with no other change", () => {
    write("app/main.exs", `use "lib/helper"\nuse "pkglib"\n`);
    write("lib/helper.exs", `helper()\n`);

    // The only line this feature requires. Everything below is the default
    // registry plus the new extractor.
    const registry = createRegistry([...DEFAULT_EXTRACTORS, exampleScriptExtractor]);

    const scan = scanProject(tempDir, { registry });
    expect(scan.filesScanned).toBe(2);
    expect(scan.parseCoverage).toBe(1);
    expect(scan.byLanguage["example-script"]).toEqual({
      files: 2,
      imports: 2,
      incomplete: 0,
    });
    // The new language's external package reaches the npm set only if it
    // declares the npm ecosystem — it declares its own, so it does not.
    expect(scan.imports).toEqual([]);

    const result = deriveFromScan(scan, { registry });
    expect(result.nodes.map((n) => n.id)).toContain("module:app/main.exs");
    expect(result.edges.some((e) => e.to === "module:lib/helper.exs")).toBe(true);
    expect(result.nodes.some((n) => n.id === "external:examplescript:pkglib")).toBe(true);
    // Provenance names the language that produced it, with no central registry
    // of rule names to update.
    const edge = result.edges.find((e) => e.to === "module:lib/helper.exs");
    expect(edge?.provenance.derived && edge.provenance.rule).toBe("example-script/import-edge");
  });

  it("a real language the registry does not claim is counted against coverage", () => {
    // The counterpart to the test above: the registry is the *only* place that
    // decides what arkive can read, so what it does not claim has to be visible
    // in the coverage number. A walker that simply skipped unknown extensions
    // would pass the previous test and fail this one.
    write("app/main.exs", `use "lib/helper"\n`);
    write("app/model.rb", `puts 1\n`);

    const scan = scanProject(tempDir, {
      registry: createRegistry([...DEFAULT_EXTRACTORS, exampleScriptExtractor]),
    });

    expect(scan.filesScanned).toBe(1);
    expect(scan.filesUnreadable).toBe(1);
    expect(scan.parseCoverage).toBeCloseTo(0.5, 5);
    expect(scan.unsupported).toEqual([{ extension: ".rb", files: 1 }]);
  });

  it("a file that is not source at all is skipped without counting against coverage", () => {
    // The other side of the same line, and the reason `UNSUPPORTED_EXTENSIONS`
    // exists in `scanner.ts`. Counting `.md`, `.json` and `.png` as "unreadable
    // source" would drag every repository's coverage toward 50% and train the
    // reader to ignore the number — which defeats the point of having it.
    write("app/main.exs", `use "lib/helper"\n`);
    write("README.md", `# docs\n`);
    write("package.json", `{"name":"x"}`);

    const scan = scanProject(tempDir, {
      registry: createRegistry([...DEFAULT_EXTRACTORS, exampleScriptExtractor]),
    });

    expect(scan.filesUnreadable).toBe(0);
    expect(scan.parseCoverage).toBe(1);
  });
});

describe("the registry refuses an ambiguous claim", () => {
  it("throws when two extractors claim one extension", () => {
    const clash: Extractor = {
      ...exampleScriptExtractor,
      id: "other",
      language: "Other",
    };

    // Silently letting the second registration win means one language stops
    // running and nobody finds out until a graph is missing half of it.
    expect(() => createRegistry([exampleScriptExtractor, clash])).toThrow(/both claim/);
  });

  it("reports its own vocabulary for the coverage report", () => {
    expect(defaultRegistry.ids).toEqual(["ts-js", "python", "go"]);
    expect(defaultRegistry.languages).toEqual([
      "TypeScript/JavaScript",
      "Python",
      "Go",
    ]);
    expect(defaultRegistry.extensions).toContain(".ts");
    expect(defaultRegistry.extensions).toContain(".py");
    expect(defaultRegistry.extensions).toContain(".go");
  });

  it("resolves a path to its extractor by extension, case-insensitively", () => {
    expect(defaultRegistry.forPath("src/a.ts")?.id).toBe("ts-js");
    expect(defaultRegistry.forPath("src/A.TSX")?.id).toBe("ts-js");
    expect(defaultRegistry.forPath("src/a.py")?.id).toBe("python");
    expect(defaultRegistry.forPath("src/main.go")?.id).toBe("go");
    expect(defaultRegistry.forPath("src/a.rb")).toBeUndefined();
    // A dot in a directory name is not an extension.
    expect(defaultRegistry.forPath("src/v1.2/notes")).toBeUndefined();
  });

  it("every extractor directory holds a module the registry exports", () => {
    // The one place a new extractor can be forgotten: written, correct, and
    // never registered — in which case its files are counted as unreadable and
    // its language silently stops existing. This assertion turns that mistake
    // into a failing test rather than a lower coverage number nobody reads.
    const dir = join(process.cwd(), "src", "analysis", "extractors");
    const infrastructure = new Set(["types.ts", "registry.ts", "node-builtins.ts", "index.ts"]);
    const modules = readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !infrastructure.has(name))
      .map((name) => name.replace(/\.ts$/, ""));

    expect(modules.length).toBeGreaterThan(0);
    for (const module of modules) {
      expect(
        DEFAULT_EXTRACTORS.some((extractor) => extractor.id === module),
        `${module}.ts exists but no extractor is registered under that id`
      ).toBe(true);
    }
  });
});