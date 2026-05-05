import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanProject } from "../../src/analysis/scanner.js";

describe("project scanner", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "archlearn-scan-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty results when no package.json exists", () => {
    const result = scanProject(tempDir);
    expect(result.dependencies).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.hasPackageJson).toBe(false);
  });

  it("extracts dependencies from package.json", () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: { express: "^4.0.0", pg: "^8.0.0" },
        devDependencies: { vitest: "^1.0.0" },
      }),
      "utf-8"
    );
    const result = scanProject(tempDir);
    expect(result.hasPackageJson).toBe(true);
    expect(result.dependencies.sort()).toEqual(["express", "pg", "vitest"]);
  });

  it("scans .ts and .js imports under src/", () => {
    mkdirSync(join(tempDir, "src", "nested"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "a.ts"),
      `import express from "express";\nimport { z } from "zod";\nimport "./local.js";`,
      "utf-8"
    );
    writeFileSync(
      join(tempDir, "src", "nested", "b.js"),
      `const pg = require("pg");\nconst local = require("../a.js");`,
      "utf-8"
    );
    const result = scanProject(tempDir);
    expect(result.imports.sort()).toEqual(["express", "pg", "zod"]);
  });

  it("ignores relative imports and node: builtins", () => {
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "a.ts"),
      `import "./relative.js";\nimport "../up.js";\nimport fs from "node:fs";\nimport path from "path";`,
      "utf-8"
    );
    const result = scanProject(tempDir);
    expect(result.imports).toEqual([]);
  });

  it("normalizes scoped packages to their full name", () => {
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "a.ts"),
      `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";`,
      "utf-8"
    );
    const result = scanProject(tempDir);
    expect(result.imports).toEqual(["@modelcontextprotocol/sdk"]);
  });

  it("returns empty imports when src/ does not exist", () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { foo: "1.0.0" } }),
      "utf-8"
    );
    const result = scanProject(tempDir);
    expect(result.imports).toEqual([]);
    expect(result.dependencies).toEqual(["foo"]);
  });
});
