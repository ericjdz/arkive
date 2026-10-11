import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { preToolUse } from "../../src/hooks/pre-tool-use.js";
import { matchSourcePath, matchesSourcePattern, readArkiveConfig, toPosix } from "../../src/hooks/index.js";
import { cleanProject, derived, authored, makeProject, removeProject } from "./fixtures.js";

/**
 * `pre-tool-use` is the hook that closes the read/update gap.
 *
 * ADR-0005 rejected "hook only `SessionStart`" because session-start is the
 * highest-value hook but this is what closes the distance between "read at
 * start" and "update after a change" — and the update is the half that never
 * happens.
 */

describe("pre-tool-use fires only where it has something to say", () => {
  it("ignores tools that do not change files", () => {
    const dir = cleanProject();
    try {
      for (const toolName of ["Bash", "Read", "Grep", "WebFetch", "Task"]) {
        const result = preToolUse({ cwd: dir, toolName, filePath: join(dir, "src", "app.ts") });
        expect(result.context, toolName).toBeNull();
      }
    } finally {
      removeProject(dir);
    }
  });

  it("ignores a file edit with no path", () => {
    const dir = cleanProject();
    try {
      expect(preToolUse({ cwd: dir, toolName: "Write" }).context).toBeNull();
    } finally {
      removeProject(dir);
    }
  });

  it("says nothing about a non-source file", () => {
    // A hook on every edit that fires on every edit is noise, and noise is how a
    // hook gets ignored.
    const dir = cleanProject();
    try {
      expect(preToolUse({ cwd: dir, toolName: "Write", filePath: join(dir, "README.md") }).context).toBeNull();
      expect(preToolUse({ cwd: dir, toolName: "Edit", filePath: join(dir, "notes.txt") }).context).toBeNull();
    } finally {
      removeProject(dir);
    }
  });

  it("says nothing about vendored or build directories", () => {
    const dir = cleanProject();
    try {
      const path = join(dir, "node_modules", "express", "index.js");
      expect(preToolUse({ cwd: dir, toolName: "Write", filePath: path }).context).toBeNull();
      expect(
        preToolUse({ cwd: dir, toolName: "Write", filePath: join(dir, "dist", "cli", "index.js") }).context
      ).toBeNull();
    } finally {
      removeProject(dir);
    }
  });

  it("says nothing about a file outside the project", () => {
    const dir = cleanProject();
    try {
      expect(
        preToolUse({ cwd: dir, toolName: "Write", filePath: "/somewhere/else/src/app.ts" }).context
      ).toBeNull();
    } finally {
      removeProject(dir);
    }
  });
});

describe("pre-tool-use names the node a source path resolves to", () => {
  it("reports the node and its summary for a known module", () => {
    const dir = cleanProject();
    try {
      const arch = JSON.parse(readFileSync(join(dir, "arkive", "architecture.json"), "utf-8"));
      arch.nodes = [
        {
          id: "cli",
          kind: "module",
          name: "cli",
          summary: "Command-line entrypoint.",
          path: "src/cli",
          tech: "Node.js",
          provenance: derived("src/cli/index.ts:1"),
        },
      ];
      writeFileSync(join(dir, "arkive", "architecture.json"), JSON.stringify(arch, null, 2));

      const context = preToolUse({ cwd: dir, toolName: "Edit", filePath: join(dir, "src", "cli", "run.ts") })
        .context ?? "";
      expect(context).toContain("`src/cli/run.ts`");
      expect(context).toContain("`cli`");
      expect(context).toContain("module");
      expect(context).toContain("Command-line entrypoint.");
    } finally {
      removeProject(dir);
    }
  });

  it("surfaces the inbound edges of the node being edited", () => {
    const dir = cleanProject();
    try {
      const arch = JSON.parse(readFileSync(join(dir, "arkive", "architecture.json"), "utf-8"));
      // Both endpoints have to exist: `validateGraphDocument` hard-fails on an
      // edge that points at an unknown node, so a fixture with one endpoint
      // would exercise the read-failure path rather than the nudge.
      arch.nodes = [
        {
          id: "api",
          kind: "service",
          name: "API",
          summary: "The HTTP API.",
          provenance: authored(),
        },
        {
          id: "cli",
          kind: "module",
          name: "cli",
          summary: "Command-line entrypoint.",
          path: "src/cli",
          provenance: authored(),
        },
      ];
      arch.edges = [
        {
          id: "reads:api->cli",
          from: "api",
          to: "cli",
          kind: "reads",
          provenance: derived("src/cli/read.ts:4"),
        },
      ];
      writeFileSync(join(dir, "arkive", "architecture.json"), JSON.stringify(arch, null, 2));

      const context = preToolUse({ cwd: dir, toolName: "Edit", filePath: join(dir, "src", "cli", "read.ts") })
        .context ?? "";
      expect(context).toContain("Depends on it");
      expect(context).toContain("api -reads-> cli");
    } finally {
      removeProject(dir);
    }
  });

  it("surfaces the decisions attached to the node being edited", () => {
    const dir = cleanProject();
    try {
      const arch = JSON.parse(readFileSync(join(dir, "arkive", "architecture.json"), "utf-8"));
      arch.nodes = [
        {
          id: "store",
          kind: "datastore",
          name: "store",
          summary: "The architecture record on disk.",
          path: "src/cli",
          provenance: authored(),
        },
      ];
      arch.decisions = [
        {
          id: "dec-001",
          topic: "record format",
          decision: "v2 graph, not a service list",
          rationale: "edges need typed provenance",
          alternatives: [{ name: "service list", whyNot: "cannot express derives_from" }],
          timestamp: "2026-01-01T00:00:00.000Z",
          subjects: [{ kind: "node", ref: "store" }],
        },
      ];
      writeFileSync(join(dir, "arkive", "architecture.json"), JSON.stringify(arch, null, 2));

      const context = preToolUse({ cwd: dir, toolName: "Edit", filePath: join(dir, "src", "cli", "read.ts") })
        .context ?? "";
      expect(context).toContain("record format");
      expect(context).toContain("v2 graph");
    } finally {
      removeProject(dir);
    }
  });

  it("tells the agent a source path it does not recognise", () => {
    // The second case is the one that matters: a source path with no node is
    // the signal that a module boundary may have just appeared, and the update
    // half of the lifecycle rule is the half prose never gets done.
    const dir = cleanProject();
    try {
      const result = preToolUse({ cwd: dir, toolName: "Write", filePath: join(dir, "src", "billing", "worker.ts") });
      expect(result.context).toContain("not in the architecture graph");
      expect(result.block).toBe(false);
      expect(result.exitCode).toBe(0);
    } finally {
      removeProject(dir);
    }
  });
});

describe("pre-tool-use never blocks and never writes", () => {
  it("carries no permission decision at all", () => {
    const dir = cleanProject();
    try {
      const result = preToolUse({ cwd: dir, toolName: "Write", filePath: join(dir, "src", "new.ts") });
      expect(result.block).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.reason).toBeNull();
    } finally {
      removeProject(dir);
    }
  });
});

describe("Windows paths are normalised before anything is compared", () => {
  // Claude Code documents that on Windows `tool_input.file_path` arrives with
  // backslashes even when the hook runs under Git Bash, and that a comparison
  // written with forward slashes then never matches — so the tool call proceeds
  // as if the hook had nothing to say. Silent, total, and invisible.
  it("normalises backslashes to forward slashes", () => {
    expect(toPosix("C:\\repo\\src\\app.ts")).toBe("C:/repo/src/app.ts");
    expect(toPosix("src/app.ts")).toBe("src/app.ts");
  });

  it("matches a backslash path against a project root", () => {
    const dir = cleanProject();
    try {
      const backslashPath = join(dir, "src", "app.ts").replace(/\//g, "\\");
      const match = matchSourcePath(backslashPath, dir);
      expect(match.isSource).toBe(true);
      expect(match.relPath).toBe("src/app.ts");
    } finally {
      removeProject(dir);
    }
  });
});

describe("arkive.config.json decides what counts as source", () => {
  it("matches whole path segments, and a matched directory covers everything under it", () => {
    // The same rule `.gitignore` uses: a directory pattern matches the directory
    // and everything beneath it, at any depth.
    expect(matchesSourcePattern("src/a.ts", "src")).toBe(true);
    expect(matchesSourcePattern("src/deep/nested/a.ts", "src")).toBe(true);
    expect(matchesSourcePattern("srcery/a.ts", "src")).toBe(false);
    expect(matchesSourcePattern("packages/api/src/a.ts", "packages/*")).toBe(true);
    expect(matchesSourcePattern("packages/a/b/src/a.ts", "packages/*")).toBe(true);
    expect(matchesSourcePattern("packages/api/src/a.ts", "packages/api/**")).toBe(true);
    expect(matchesSourcePattern("services/api/a.ts", "packages/*")).toBe(false);
    expect(matchesSourcePattern("a/b/c.ts", "**/c.ts")).toBe(true);
  });

  it("is read when present and used verbatim", () => {
    const dir = cleanProject();
    try {
      writeFileSync(
        join(dir, "arkive.config.json"),
        JSON.stringify({ sourcePaths: ["services/payments"] })
      );
      expect(readArkiveConfig(dir).sourcePaths).toEqual(["services/payments"]);
      expect(
        matchSourcePath(join(dir, "services", "payments", "index.ts"), dir).isSource
      ).toBe(true);
      // A .ts file outside the configured root is no longer relevant.
      expect(matchSourcePath(join(dir, "src", "app.ts"), dir).isSource).toBe(false);
    } finally {
      removeProject(dir);
    }
  });

  it("falls back to defaults when it is absent, empty, or malformed", () => {
    // A configuration file that stops the hook from running would make arkive a
    // dependency of its own configuration.
    const dir = cleanProject();
    try {
      expect(readArkiveConfig(dir).sourcePaths).toBeNull();

      writeFileSync(join(dir, "arkive.config.json"), "{ not json");
      expect(readArkiveConfig(dir).sourcePaths).toBeNull();
      expect(matchSourcePath(join(dir, "src", "app.ts"), dir).isSource).toBe(true);

      writeFileSync(join(dir, "arkive.config.json"), JSON.stringify({ unrelated: true }));
      expect(readArkiveConfig(dir).sourcePaths).toBeNull();
    } finally {
      removeProject(dir);
    }
  });
});

describe("a project without a document gets nothing, loudly or quietly", () => {
  it("is silent", () => {
    const dir = makeProject({ withoutDocument: true });
    try {
      expect(preToolUse({ cwd: dir, toolName: "Write", filePath: join(dir, "src", "a.ts") }).context).toBeNull();
    } finally {
      removeProject(dir);
    }
  });

  it("still finds a source path in a deep subdirectory", () => {
    const dir = makeProject({});
    try {
      mkdirSync(join(dir, "packages", "api"), { recursive: true });
      const result = preToolUse({
        cwd: join(dir, "packages", "api"),
        toolName: "Edit",
        filePath: join(dir, "packages", "api", "handler.ts"),
      });
      expect(result.context).toContain("packages/api/handler.ts");
    } finally {
      removeProject(dir);
    }
  });
});
