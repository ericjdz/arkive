import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readArchitecture, writeArchitecture } from "../../src/io/architecture-file.js";
import { createEmptyArchitectureV2 } from "../../src/schema/validate-graph.js";
import { authoredBy, derivedFrom } from "../../src/schema/provenance.js";

/**
 * Scratch projects for the hook tests.
 *
 * Each fixture is built to produce one specific `DriftReport` shape, because
 * the gate's whole job is to tell those shapes apart:
 *
 * | Fixture | conclusive | critical kind | gate |
 * |---|---|---|---|
 * | `cleanProject` | yes | — | allow |
 * | `projectWithDanglingEdge` | yes | `dangling-edge` | **block** |
 * | `inconclusiveProject` | **no** | `incomplete-scan` | allow, report loudly |
 * | `projectWithoutDocument` | — | — | **block** |
 * | `projectWithBrokenDocument` | — | — | **block** |
 */

/**
 * Provenance constructors.
 *
 * Re-exported so every fixture builds the same shape the schema requires — a
 * `discriminatedUnion` on `derived`, where the authored branch carries
 * `authoredBy` and the derived branch carries `rule` and `evidence`, and neither
 * branch may carry the other's keys.
 */
export const authored = () => authoredBy("agent");
export const derived = (evidence: string) => derivedFrom("fixture-node", [evidence]);

export interface ProjectOptions {
  /** Files to write under `src/`. */
  files?: Record<string, string>;
  /** Skip `arkive/architecture.json` entirely. */
  withoutDocument?: boolean;
  /** Write a document that cannot be parsed. */
  brokenDocument?: boolean;
  /** Add an edge preserved across a node deletion. Blocks the commit. */
  danglingEdge?: boolean;
  /** Track an `express` service, so import rules have something to match. */
  trackExpress?: boolean;
  /** Create `.git/hooks` so the installer believes it is in a repository. */
  gitRepo?: boolean;
}

export function makeProject(options: ProjectOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "arkive-hooks-test-"));

  if (options.gitRepo !== false) mkdirSync(join(dir, ".git", "hooks"), { recursive: true });

  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { express: "^4.0.0" } }, null, 2)}\n`
  );

  for (const [name, contents] of Object.entries(
    options.files ?? { "app.ts": 'import express from "express";\nexport const app = express();\n' }
  )) {
    const full = join(dir, "src", name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }

  if (options.withoutDocument) return dir;

  if (options.brokenDocument) {
    mkdirSync(join(dir, "arkive"), { recursive: true });
    writeFileSync(join(dir, "arkive", "architecture.json"), "{ this is not json", "utf-8");
    return dir;
  }

  mkdirSync(join(dir, "arkive"), { recursive: true });
  const scaffold = createEmptyArchitectureV2("fixture", "Hook test fixture");
  const written = writeArchitecture(dir, scaffold);
  if (!written.success) throw new Error(written.error);

  if (options.trackExpress || options.danglingEdge) {
    const read = readArchitecture(dir);
    if (!read.success) throw new Error(read.error);
    read.data.services.push({
      id: "api",
      name: "API",
      type: "backend",
      technology: "express",
      description: "The HTTP API",
      dependencies: [],
    });
    if (options.danglingEdge) {
      // Preserved rather than dropped on purpose (ADR-0001:141-145), which is
      // exactly what makes it a `critical` finding: the document asserts a
      // relationship that resolves to nothing.
      read.data.edges.push({
        id: "calls:api->payments",
        from: "api",
        to: "payments",
        kind: "calls",
        label: "HTTP/REST",
        dangling: true,
        provenance: authoredBy("agent"),
      });
    }
    const second = writeArchitecture(dir, read.data);
    if (!second.success) throw new Error(second.error);
  }

  return dir;
}

/**
 * A project whose scan cannot cover the tree.
 *
 * Files in languages the scanner has no extractor for are counted as unreadable
 * rather than ignored, which drives `parseCoverage` below 1 and makes
 * `detectDrift` emit `incomplete-scan` — a `critical` finding that means "arkive
 * could not look", not "the document is wrong".
 */
export function inconclusiveFiles(): Record<string, string> {
  return {
    "app.ts": 'import express from "express";\nexport const app = express();\n',
    "deploy.sh": "#!/bin/sh\necho deploy\n",
    "worker.py": "import os\n",
    "main.go": "package main\n",
  };
}

export function cleanProject(): string {
  return makeProject({ trackExpress: true });
}

export function projectWithDanglingEdge(): string {
  return makeProject({ danglingEdge: true });
}

export function inconclusiveProject(): string {
  return makeProject({ files: inconclusiveFiles(), trackExpress: true });
}

export function removeProject(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Capture the strings a hook writes, without touching the real process streams.
 *
 * `cwd` goes into the stdin payload as well as into `io.cwd`, because the two
 * are different channels: a harness event tells the hook where it is through its
 * JSON, and only the git gate reads the process working directory. Tests that
 * set one and not the other silently exercise the repository root instead of
 * the fixture, which is how a hook test can pass against the wrong project.
 */
export function captureIo(cwd: string, env: NodeJS.ProcessEnv = {}, extra: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdin: JSON.stringify({ cwd, ...extra }),
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      cwd,
      env,
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}
