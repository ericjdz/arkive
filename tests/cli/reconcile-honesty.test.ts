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
 * `arkive reconcile` is the command whose output people trust without reading.
 *
 * It used to print "No drift detected. arkive/architecture.json is in sync."
 * whenever the warning list was empty — and the scanner it consulted scanned
 * `<root>/src` only, so a project laid out any other way produced an empty list
 * by never having been examined. A drift detector that says "in sync" when it
 * did not look is worse than one that says nothing, because it is believed.
 *
 * These tests drive the real CLI, because the claim is made by the CLI's
 * output, not by the function behind it.
 */

const CLI = join(process.cwd(), "src", "cli", "index.ts");

/** `npx tsx` costs seconds on Windows and this suite runs in parallel. */
const CLI_TIMEOUT = 120_000;

function runCli(args: string[]): { status: number; output: string } {
  // `npx` is a `.cmd` shim on Windows, so it has to go through a shell — the
  // same reason `tests/cli/legacy-paths.test.ts` builds a command string.
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

describe("reconcile never claims agreement it did not verify", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-reconcile-"));
    mkdirSync(arkiveDirPath(tempDir), { recursive: true });
    writeFileSync(join(tempDir, "package.json"), "{}", "utf-8");
    const scaffold = createEmptyArchitectureV2("honesty", "Honesty");
    if (!writeArchitecture(tempDir, scaffold).success) throw new Error("scaffold failed");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * A node the `untracked-service` rule can match `express` against.
   *
   * Added through the v1 authoring surface, which is what `update_architecture`
   * uses — the deprecated view is folded back onto the graph, so that is how a
   * node gets in today.
   */
  function trackExpress(): void {
    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    read.data.services.push({
      id: "api",
      name: "API",
      type: "backend",
      technology: "express",
      description: "The HTTP API",
      dependencies: [],
    });
    if (!writeArchitecture(tempDir, read.data).success) {
      throw new Error("write failed");
    }
  }

  it("does not say 'in sync' when it found no source files to look at", () => {
    // The `src`-assumption bug, reproduced: a manifest, no source, zero warnings.
    const exit = runCli(["reconcile", "--dir", tempDir]);

    expect(exit.output).not.toMatch(/is in sync/i);
    expect(exit.output).toMatch(/incomplete-scan/i);
    expect(exit.status).not.toBe(0);
  }, CLI_TIMEOUT);

  it("says 'in sync' only after actually reading the source", () => {
    mkdirSync(join(tempDir, "lib"), { recursive: true });
    writeFileSync(join(tempDir, "lib", "index.ts"), `import express from "express";\n`, "utf-8");
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      "utf-8"
    );
    // The import has to map to something in the document, or `untracked-service`
    // fires and the run is (correctly) not clean.
    trackExpress();

    const exit = runCli(["reconcile", "--dir", tempDir]);

    expect(exit.output).toMatch(/is in sync/i);
    // ...and it says how much it looked at, so the claim is checkable.
    expect(exit.output).toMatch(/scanned 1 file\(s\)/);
    expect(exit.output).toMatch(/\blib\b/);
  }, CLI_TIMEOUT);

  it("a polyglot repository lowers coverage and says so", () => {
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "a.ts"), `import express from "express";`, "utf-8");
    writeFileSync(join(tempDir, "src", "b.py"), `import requests`, "utf-8");
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      "utf-8"
    );

    const exit = runCli(["reconcile", "--dir", tempDir]);

    expect(exit.output).not.toMatch(/is in sync/i);
    expect(exit.output).toMatch(/50\.0%/);
    expect(exit.output).toMatch(/not JavaScript\/TypeScript/);
  }, CLI_TIMEOUT);

  it("reports the scan coverage alongside any other findings", () => {
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "a.ts"), `import "undeclared-thing";`, "utf-8");

    const exit = runCli(["reconcile", "--dir", tempDir]);

    expect(exit.output).toMatch(/undeclared-thing/);
    expect(exit.output).toMatch(/Scan coverage: 100\.0%/);
  }, CLI_TIMEOUT);

  it("reports a dangling edge as critical, because the document asserts something false", () => {
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "a.ts"), `import express from "express";`, "utf-8");
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      "utf-8"
    );
    trackExpress();

    // A preserved dangling reference: written by the author before the node was
    // deleted, kept on purpose (ADR-0001:141-145), and reported rather than
    // quietly repaired.
    const read = readArchitecture(tempDir);
    if (!read.success) throw new Error(read.error);
    read.data.edges.push({
      id: "calls:api->deleted-service",
      from: "api",
      to: "deleted-service",
      kind: "calls",
      label: "stdio",
      dangling: true,
      provenance: { derived: false, authoredBy: "agent" },
    });
    if (!writeArchitecture(tempDir, read.data).success) throw new Error("write failed");

    const exit = runCli(["reconcile", "--dir", tempDir]);

    expect(exit.output).toMatch(/\(dangling-edge\)/);
    expect(exit.output).toMatch(/\[critical\]/);
    expect(exit.status).not.toBe(0);
  }, CLI_TIMEOUT);

  it("`--quiet` suppresses output — the flag the post-commit hook has always passed", () => {
    // `src/cli/commands/hooks.ts:10` installs a hook running
    // `arkive reconcile --quiet`. Commander rejects an undeclared option, so the
    // hook had been writing its usage error to stderr on every commit.
    const loud = runCli(["reconcile", "--dir", tempDir]);
    const quiet = runCli(["reconcile", "--dir", tempDir, "--quiet"]);

    expect(loud.output.length).toBeGreaterThan(0);
    expect(quiet.output.trim()).toBe("");
    // It still reports through the exit code, so CI can gate on it.
    expect(quiet.status).not.toBe(0);
  }, CLI_TIMEOUT);

  it("the flag is declared in the CLI help", () => {
    const help = runCli(["reconcile", "--help"]);
    expect(help.output).toContain("--quiet");
  }, CLI_TIMEOUT);

  it("reports a missing document rather than a clean bill of health", () => {
    rmSync(tempDir, { recursive: true, force: true });
    const exit = runCli(["reconcile", "--dir", tempDir]);

    expect(exit.status).not.toBe(0);
    expect(exit.output).toMatch(/not found/i);
  }, CLI_TIMEOUT);
});