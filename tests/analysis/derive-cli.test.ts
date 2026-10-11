import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  arkiveDirPath,
  readArchitecture,
  writeArchitecture,
} from "../../src/io/architecture-file.js";
import { createEmptyArchitectureV2 } from "../../src/schema/validate-graph.js";

/**
 * The derived graph, as the CLI shows it.
 *
 * The issue's acceptance criteria are stated about what a user sees — "reports
 * parse coverage as a percentage", "a partial parse never reports in sync" —
 * and `src/cli/commands/reconcile.ts` is the only place those claims are made
 * to a human. Testing the function behind it would leave the claim untested.
 *
 * Note on `--include` / `--exclude`: they are passed through here so the flags
 * are exercised end to end rather than only at the function boundary, which is
 * where a Commander wiring mistake would otherwise live.
 */

const CLI = join(process.cwd(), "src", "cli", "index.ts");

/** `npx tsx` costs seconds on Windows and this suite runs in parallel. */
const CLI_TIMEOUT = 120_000;

function runCli(args: string[]): { status: number; output: string } {
  const command = `npx tsx "${CLI}" ${args
    .map((a) => (/\s/.test(a) ? `"${a}"` : a))
    .join(" ")}`;
  try {
    const output = execSync(command, {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("reconcile reports the derived graph and its coverage", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-graph-cli-"));
    mkdirSync(arkiveDirPath(tempDir), { recursive: true });
    writeFileSync(join(tempDir, "package.json"), "{}", "utf-8");
    const scaffold = createEmptyArchitectureV2("graph", "Graph");
    if (!writeArchitecture(tempDir, scaffold).success) throw new Error("scaffold failed");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function write(relPath: string, content: string): void {
    const full = join(tempDir, ...relPath.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }

  it("reports node and edge counts, per-language coverage, and the total", () => {
    write("src/index.ts", `import express from "express";\nimport { r } from "./render.js";\n`);
    write("src/render.ts", `import express from "express";\nexport const r = 1;\n`);
    write("pkg/mod.py", `import os\n`);
    write("cmd/main.go", `package main\nimport "fmt"\nfunc main() { fmt.Println() }\n`);

    const exit = runCli(["reconcile", "--dir", tempDir]);

    expect(exit.output).toMatch(/Derived graph:/);
    expect(exit.output).toMatch(/module nodes/);
    expect(exit.output).toMatch(/external nodes/);
    expect(exit.output).toMatch(/imports edges/);
    expect(exit.output).toMatch(/languages:/);
    expect(exit.output).toMatch(/ts-js/);
    expect(exit.output).toMatch(/python/);
    expect(exit.output).toMatch(/go/);
    expect(exit.output).toMatch(/100\.0%/);
  }, CLI_TIMEOUT);

  it("reports an unresolved import as a file:line a reader can open", () => {
    write("src/a.ts", `import { gone } from "./deleted.js";\n`);

    const exit = runCli(["reconcile", "--dir", tempDir]);

    expect(exit.output).toMatch(/unresolved:/);
    expect(exit.output).toMatch(/src\/a\.ts:1/);
    expect(exit.output).toMatch(/"\.{1,2}\/deleted\.js"/);
    // ...and it is critical, because a graph that points at a module which does
    // not exist is asserting something false about the repository.
    expect(exit.output).toMatch(/\[critical\]/);
    expect(exit.status).not.toBe(0);
  }, CLI_TIMEOUT);

  it("states the coverage the graph actually has", () => {
    write("src/a.ts", `export const a = 1;`);
    write("src/b.rb", `puts 1\n`);

    const exit = runCli(["reconcile", "--dir", tempDir]);

    expect(exit.output).toMatch(/50\.0%/);
    expect(exit.output).toMatch(/\.rb/);
    expect(exit.output).not.toMatch(/is in sync/i);
  }, CLI_TIMEOUT);

  it("--include narrows the scan and says which paths it covered", () => {
    write("src/a.ts", `import express from "express";`);
    write("scripts/build.ts", `import express from "express";`);
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      "utf-8"
    );

    const all = runCli(["reconcile", "--dir", tempDir, "--no-graph"]);
    const scoped = runCli(["reconcile", "--dir", tempDir, "--include", "src"]);

    expect(all.output).toMatch(/scanned 2 file\(s\)/);
    expect(scoped.output).toMatch(/scanned 1 file\(s\)/);
    expect(scoped.output).toMatch(/restricted to src/);
  }, CLI_TIMEOUT);

  it("--exclude drops a path and says it did", () => {
    write("src/a.ts", `export const a = 1;`);
    write("src/a.test.ts", `export const t = 1;`);

    const exit = runCli(["reconcile", "--dir", tempDir, "--exclude", "src/a.test.ts"]);

    expect(exit.output).toMatch(/scanned 1 file\(s\)/);
    expect(exit.output).toMatch(/excludes src\/a\.test\.ts/);
  }, CLI_TIMEOUT);

  it("--no-graph suppresses the graph summary but not the drift report", () => {
    write("src/a.ts", `import "undeclared-thing";`);

    const withGraph = runCli(["reconcile", "--dir", tempDir]);
    const without = runCli(["reconcile", "--dir", tempDir, "--no-graph"]);

    expect(withGraph.output).toMatch(/Derived graph:/);
    expect(without.output).not.toMatch(/Derived graph:/);
    expect(without.output).toMatch(/undeclared-thing/);
  }, CLI_TIMEOUT);

  it("never rewrites the document", () => {
    // `reconcile` is a diagnostic (ADR-0002:114). Persisting the derived graph
    // is issue 0007's continuous reconciliation, and a command that quietly
    // rewrote a user's architecture file on every invocation is not a command
    // anyone can run from a git hook.
    write("src/a.ts", `import express from "express";`);

    const before = readArchitecture(tempDir);
    if (!before.success) throw new Error(before.error);
    const beforeText = JSON.stringify(before.data.nodes);

    runCli(["reconcile", "--dir", tempDir]);

    const after = readArchitecture(tempDir);
    if (!after.success) throw new Error(after.error);
    expect(JSON.stringify(after.data.nodes)).toBe(beforeText);
  }, CLI_TIMEOUT);
});