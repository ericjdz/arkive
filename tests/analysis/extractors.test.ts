import { describe, it, expect } from "vitest";
import { tsJsExtractor, stripJsNoise } from "../../src/analysis/extractors/ts-js.js";
import { pythonExtractor } from "../../src/analysis/extractors/python.js";
import { goExtractor } from "../../src/analysis/extractors/go.js";
import type { ExtractionContext, ProjectLayout } from "../../src/analysis/extractors/types.js";

/**
 * Extractor unit tests.
 *
 * Each of the three languages carries one class of mistake that the others do
 * not, and each is tested here rather than discovered later:
 *
 * - **JavaScript/TypeScript** can fabricate evidence. A regex over raw text
 *   finds `import x from "y"` inside a comment, inside a docstring, and inside
 *   a test fixture's expected value. Each of those becomes a graph edge citing a
 *   line that does not import anything — which is worse than a missing edge,
 *   because a missing edge is visible.
 * - **Python** has docstrings and relative imports. A module's first statement
 *   is very often a string containing the word "import".
 * - **Go** has raw strings, block imports, and a three-way choice between
 *   "standard library", "this repository" and "a third party" that the syntax
 *   does not decide.
 */

function context(
  source: string,
  path = "src/a.ts",
  overrides: Partial<ProjectLayout> = {}
): ExtractionContext {
  const slash = path.lastIndexOf("/");
  return {
    path,
    dir: slash === -1 ? "" : path.slice(0, slash),
    source,
    layout: {
      root: "/repo",
      hasFile: () => false,
      hasDirectory: () => false,
      searchRoots: ["", "src"],
      aliases: [],
      goModules: [],
      ...overrides,
    },
  };
}

function specifiers(ctx: ExtractionContext): string[] {
  return ctxExtractor(ctx).map((found) => found.specifier);
}

function ctxExtractor(ctx: ExtractionContext) {
  const extractor =
    ctx.path.endsWith(".py") ? pythonExtractor : ctx.path.endsWith(".go") ? goExtractor : tsJsExtractor;
  return extractor.extract(ctx).imports;
}

describe("TypeScript / JavaScript", () => {
  it("finds every import form the issue names", () => {
    const source = [
      `import defaultExport from "pkg-a";`,
      `import { named } from "pkg-b";`,
      `import * as ns from "pkg-c";`,
      `import type { T } from "pkg-d";`,
      `import "pkg-e";`,
      `export { x } from "pkg-f";`,
      `export * from "pkg-g";`,
      `const lazy = await import("pkg-h");`,
      `const cjs = require("pkg-i");`,
    ].join("\n");

    const result = tsJsExtractor.extract(context(source));
    expect(result.complete).toBe(true);
    expect(result.imports.map((i) => i.specifier).sort()).toEqual([
      "pkg-a", "pkg-b", "pkg-c", "pkg-d", "pkg-e",
      "pkg-f", "pkg-g", "pkg-h", "pkg-i",
    ]);
    expect(result.imports.every((i) => i.line >= 1)).toBe(true);
    // And each form is labelled, because "loaded eagerly" and "loaded at
    // runtime" are different facts that a walkthrough will eventually ask about.
    const forms = Object.fromEntries(result.imports.map((i) => [i.specifier, i.form]));
    expect(forms["pkg-a"]).toBe("import-from");
    expect(forms["pkg-d"]).toBe("import-type");
    expect(forms["pkg-e"]).toBe("side-effect-import");
    expect(forms["pkg-f"]).toBe("re-export");
    expect(forms["pkg-h"]).toBe("dynamic-import");
    expect(forms["pkg-i"]).toBe("require");
  });

  it("does not fabricate an edge from a line comment", () => {
    const source = [`// import x from "commented-out";`, `import y from "real";`].join("\n");
    const result = tsJsExtractor.extract(context(source));
    expect(result.imports.map((i) => i.specifier)).toEqual(["real"]);
  });

  it("does not fabricate an edge from a block comment", () => {
    const source = [
      `/**`,
      ` * Usage:`,
      ` *   import { Thing } from "documented";`,
      ` */`,
      `import real from "real";`,
    ].join("\n");
    expect(specifiers(context(source))).toEqual(["real"]);
  });

  it("does not fabricate an edge from a docstring pasted into a template literal", () => {
    const source = [
      "const docs = `",
      "  import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
      "`;",
      `import real from "real";`,
    ].join("\n");
    expect(specifiers(context(source))).toEqual(["real"]);
  });

  it("does not fabricate an edge from a test fixture's expected string", () => {
    const source = [
      `test("parses imports", () => {`,
      `  expect(src).toContain('import x from "y"');`,
      `});`,
      `import real from "real";`,
    ].join("\n");
    expect(specifiers(context(source))).toEqual(["real"]);
  });

  it("does not fabricate an edge from a single-quoted string", () => {
    expect(specifiers(context(`const s = 'import a from "b"';\nimport real from "real";`))).toEqual([
      "real",
    ]);
  });

  it("reports an unterminated template literal rather than claiming zero imports", () => {
    // This is the honesty contract at the extractor level. A truncated or
    // unusual file where the stripper runs off the end must not produce a clean
    // "no imports here" — it has to produce "I did not finish reading".
    const source = ["const a = `never closed", `import hidden from "hidden";`].join("\n");
    const result = tsJsExtractor.extract(context(source));

    expect(result.complete).toBe(false);
    expect(result.note).toMatch(/unterminated/i);
    // The imports found before the break are kept, because they are real.
    expect(result.imports).toEqual([]);
  });

  it("keeps line numbers correct across blanked comments", () => {
    const source = [
      `import a from "one";`,
      `// a comment`,
      `/* another`,
      `   comment */`,
      `import b from "two";`,
    ].join("\n");
    const result = tsJsExtractor.extract(context(source));

    expect(result.imports.map((i) => [i.specifier, i.line])).toEqual([
      ["one", 1],
      ["two", 5],
    ]);
  });

  it("classifies relative, builtin, aliased and bare specifiers", () => {
    const source = [
      `import { x } from "./sibling.js";`,
      `import fs from "node:fs";`,
      `import path from "path";`,
      `import { y } from "@/components/y";`,
      `import express from "express";`,
      `import { Router } from "@scope/pkg/router.js";`,
    ].join("\n");

    const result = tsJsExtractor.extract(
      context(source, "src/a.ts", { aliases: [{ prefix: "@/", targets: ["src/*"] }] })
    );
    const targets = Object.fromEntries(result.imports.map((i) => [i.specifier, i.target.kind]));

    expect(targets["./sibling.js"]).toBe("module");
    expect(targets["node:fs"]).toBe("builtin");
    expect(targets["path"]).toBe("builtin");
    // The alias prefix carries a `*` in its configured form; testing the literal
    // string instead of its head files every aliased import as a package called
    // `@`, which is a fabricated dependency.
    expect(targets["@/components/y"]).toBe("module");
    expect(targets["express"]).toBe("package");
    expect(targets["@scope/pkg/router.js"]).toBe("package");

    const scoped = result.imports.find((i) => i.specifier === "@scope/pkg/router.js");
    expect(scoped?.target).toEqual({ kind: "package", ecosystem: "npm", name: "@scope/pkg" });
  });

  it("preserves line offsets exactly when blanking", () => {
    const source = `// comment\nconst s = "text";\nimport x from "y";\n`;
    const stripped = stripJsNoise(source);
    expect(stripped.code.length).toBe(source.length);
    expect(stripped.complete).toBe(true);
  });
});

describe("Python", () => {
  it("finds plain, from, aliased and relative imports", () => {
    const source = [
      `import os`,
      `import numpy as np, pandas`,
      `from collections import OrderedDict`,
      `from . import sibling`,
      `from .helpers import build`,
      `from ..shared import thing`,
    ].join("\n");

    const result = pythonExtractor.extract(context(source, "pkg/mod.py"));
    expect(result.imports.map((i) => i.specifier)).toEqual([
      "os",
      "numpy",
      "pandas",
      "collections",
      ".",
      ".helpers",
      "..shared",
    ]);
  });

  it("does not read a docstring as an import", () => {
    const source = [
      `"""Module for thing.`,
      ``,
      `    import os happens in setup`,
      `"""`,
      `import requests`,
    ].join("\n");

    const result = pythonExtractor.extract(context(source, "pkg/mod.py"));
    expect(result.imports.map((i) => i.specifier)).toEqual(["requests"]);
  });

  it("does not read a commented-out import", () => {
    const source = [`# import os`, `import requests`].join("\n");
    expect(specifiers(context(source, "pkg/mod.py"))).toEqual(["requests"]);
  });

  it("marks the standard library as builtin rather than as a dependency", () => {
    const result = pythonExtractor.extract(context(`import os\nimport json`, "pkg/mod.py"));
    expect(result.imports.every((i) => i.target.kind === "builtin")).toBe(true);
  });

  it("resolves a relative import through the search root, not the directory", () => {
    // `src/pkg/mod.py` is package `pkg`, not `src.pkg`. Without stripping the
    // root, every relative import in a src-layout project resolves one level
    // too deep and every one of them dangles.
    // The extractor speaks Python, not repository layout: `from .helpers` in
    // `src/pkg/mod.py` names the module `pkg.helpers`, because the package of
    // `src/pkg/mod.py` is `pkg`. Turning that into a file is the resolver's
    // job, and it is what searches the roots.
    const result = pythonExtractor.extract(context(`from .helpers import build`, "src/pkg/mod.py"));
    expect(result.imports[0].target).toEqual({ kind: "module", path: "pkg/helpers" });
  });

  it("resolves an absolute module found in the repository", () => {
    const layout: Partial<ProjectLayout> = {
      hasFile: (rel) => rel === "src/pkg/helpers.py",
    };
    const result = pythonExtractor.extract(
      context(`from pkg.helpers import build`, "src/other.py", layout)
    );
    expect(result.imports[0].target).toEqual({
      kind: "module",
      path: "src/pkg/helpers",
      symbol: "build",
    });
  });

  it("treats an unfound absolute module as a PyPI package", () => {
    const result = pythonExtractor.extract(context(`import requests`, "pkg/mod.py"));
    expect(result.imports[0].target).toEqual({
      kind: "package",
      ecosystem: "pypi",
      name: "requests",
    });
  });
});

describe("Go", () => {
  it("finds single and block imports, including aliased and blank", () => {
    const source = [
      `package main`,
      ``,
      `import "fmt"`,
      ``,
      `import (`,
      `\t"strings"`,
      `\talias "github.com/x/y"`,
      `\t_ "embed"`,
      `\t. "internal/testutil"`,
      `)`,
      ``,
      `func main() {}`,
    ].join("\n");

    const result = goExtractor.extract(context(source, "src/main.go"));
    expect(result.imports.map((i) => i.specifier)).toEqual([
      "fmt",
      "strings",
      "alias github.com/x/y",
      "_ embed",
      ". internal/testutil",
    ]);
  });

  it("separates the standard library from this repository and from third parties", () => {
    const layout: Partial<ProjectLayout> = { goModules: ["example.com/app"] };
    const source = [
      `package main`,
      `import (`,
      `\t"fmt"`,
      `\t"net/http"`,
      `\t"example.com/app/internal/store"`,
      `\t"github.com/other/lib"`,
      `)`,
    ].join("\n");

    const result = goExtractor.extract(context(source, "src/main.go", layout));
    const bySpecifier = Object.fromEntries(
      result.imports.map((i) => [i.specifier, i.target.kind])
    );

    expect(bySpecifier["fmt"]).toBe("builtin");
    expect(bySpecifier["net/http"]).toBe("builtin");
    // This repository's own package must not be filed as a dependency it does
    // not have, which is the failure that produces a clean-looking lying graph.
    expect(bySpecifier["example.com/app/internal/store"]).toBe("module");
    expect(bySpecifier["github.com/other/lib"]).toBe("package");
  });

  it("does not read imports out of comments", () => {
    const source = [
      `package main`,
      `// import "commented"`,
      `/* import "also-commented" */`,
      `import "real"`,
    ].join("\n");
    expect(specifiers(context(source, "src/main.go"))).toEqual(["real"]);
  });

  it("does not let a raw string swallow the rest of the file", () => {
    const source = [
      "package main",
      "",
      "var s = `raw",
      "import \"inside-a-raw-string\"",
      "`",
      "",
      `import "after"`,
    ].join("\n");
    expect(specifiers(context(source, "src/main.go"))).toEqual(["after"]);
  });
});