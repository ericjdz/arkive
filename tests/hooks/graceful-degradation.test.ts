import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readArchitecture, writeArchitecture } from "../../src/io/architecture-file.js";
import { runStatus } from "../../src/cli/commands/status.js";
import { exportArchitecture } from "../../src/cli/commands/export.js";
import { runHook } from "../../src/hooks/runner.js";
import { executeHook } from "../../src/hooks/main.js";
import { DISABLE_ENV } from "../../src/hooks/index.js";
import { cleanProject, makeProject, projectWithDanglingEdge, removeProject } from "./fixtures.js";

/**
 * "Disabling all hooks leaves the product fully functional" — issue 0011's
 * third acceptance criterion, and the one that decides whether hooks are an
 * accelerant or a dependency.
 *
 * The test is written the way the requirement reads: a project with **no**
 * `.claude/`, **no** git hooks, and every hook switched off at the environment
 * level, where the file, the CLI, and the MCP-facing library all still work. A
 * user on Cursor, on Windsurf, on plain Codex, or on a Claude Code that predates
 * hooks is exactly this user.
 */

describe("a project with no hooks at all", () => {
  it("has no arkive artefacts on disk", () => {
    const dir = cleanProject();
    try {
      expect(existsSync(join(dir, ".claude"))).toBe(false);
      expect(existsSync(join(dir, ".git", "hooks", "pre-commit"))).toBe(false);
      expect(existsSync(join(dir, ".git", "hooks", "post-commit"))).toBe(false);
    } finally {
      removeProject(dir);
    }
  });

  it("still reads the record", () => {
    const dir = cleanProject();
    try {
      const read = readArchitecture(dir);
      expect(read.success).toBe(true);
      if (!read.success) return;
      expect(read.data.project.name).toBe("fixture");
    } finally {
      removeProject(dir);
    }
  });

  it("still writes the record, with every integrity guarantee intact", () => {
    const dir = cleanProject();
    try {
      const read = readArchitecture(dir);
      if (!read.success) throw new Error(read.error);
      read.data.project.description = "changed with no hooks installed";
      const written = writeArchitecture(dir, read.data);
      expect(written.success).toBe(true);
      // Atomic write plus a snapshot: ADR-0006's guarantees belong to the file
      // layer, not to the hook layer.
      expect(existsSync(join(dir, "arkive", "history"))).toBe(true);
    } finally {
      removeProject(dir);
    }
  });

  it("still answers `arkive status`, drift and coverage included", async () => {
    const dir = projectWithDanglingEdge();
    try {
      const result = await runStatus({ dir });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.report.drift.summary.bySeverity.critical).toBeGreaterThan(0);
      expect(result.report.counts.decisions).toBe(0);
    } finally {
      removeProject(dir);
    }
  });

  it("still exports the architecture", () => {
    const dir = cleanProject();
    try {
      const written: string[] = [];
      const original = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        exportArchitecture({ dir, format: "markdown" });
      } finally {
        process.stdout.write = original;
      }
      expect(written.join("")).toContain("fixture");
    } finally {
      removeProject(dir);
    }
  });
});

describe("every hook disabled at the environment level", () => {
  it("produces no output on any event", () => {
    const dir = projectWithDanglingEdge();
    try {
      const env = { [DISABLE_ENV]: "1" };
      for (const event of ["session-start", "pre-tool-use", "pre-compact", "stop", "pre-commit"] as const) {
        const out: string[] = [];
        const err: string[] = [];
        const code = executeHook(event, {
          stdin: JSON.stringify({ cwd: dir, tool_name: "Edit", tool_input: { file_path: join(dir, "src", "app.ts") } }),
          stdout: (text) => out.push(text),
          stderr: (text) => err.push(text),
          cwd: dir,
          env,
        });
        expect(code, event).toBe(0);
        expect(out.join(""), event).toBe("");
        expect(err.join(""), event).toBe("");
      }
    } finally {
      removeProject(dir);
    }
  });

  it("changes nothing on disk, including when the drift is critical", () => {
    const dir = projectWithDanglingEdge();
    try {
      const before = readFileSync(join(dir, "arkive", "architecture.json"), "utf-8");
      const saved = process.env[DISABLE_ENV];
      process.env[DISABLE_ENV] = "1";
      try {
        executeHook("pre-commit", {
          stdin: "",
          stdout: () => {},
          stderr: () => {},
          cwd: dir,
        });
      } finally {
        if (saved === undefined) delete process.env[DISABLE_ENV];
        else process.env[DISABLE_ENV] = saved;
      }
      expect(readFileSync(join(dir, "arkive", "architecture.json"), "utf-8")).toBe(before);
    } finally {
      removeProject(dir);
    }
  });

  it("leaves the library working, because the library never knew about hooks", async () => {
    const dir = projectWithDanglingEdge();
    try {
      const saved = process.env[DISABLE_ENV];
      process.env[DISABLE_ENV] = "1";
      try {
        expect(readArchitecture(dir).success).toBe(true);
        const status = await runStatus({ dir });
        expect(status.ok).toBe(true);
        // And the hook module itself still answers, correctly, when called
        // directly with the switch off in `process.env` — the disable is read
        // from the environment the caller passes, not captured at import time.
        expect(runHook("session-start", JSON.stringify({ cwd: dir })).context).toBeNull();
      } finally {
        if (saved === undefined) delete process.env[DISABLE_ENV];
        else process.env[DISABLE_ENV] = saved;
      }
    } finally {
      removeProject(dir);
    }
  });
});

describe("a project that has never run `arkive init`", () => {
  it("is invisible to every hook", () => {
    const dir = makeProject({ withoutDocument: true });
    try {
      for (const event of ["session-start", "pre-tool-use", "pre-compact", "stop"] as const) {
        const result = runHook(event, JSON.stringify({ cwd: dir }));
        expect(result.context, event).toBeNull();
        expect(result.notes, event).toEqual([]);
        expect(result.exitCode, event).toBe(0);
      }
    } finally {
      removeProject(dir);
    }
  });

  it("is not blocked from committing by a hook it never installed", () => {
    // The one place a missing document blocks is `pre-commit`, and only because
    // a git hook exists only where somebody asked for one. Here there is none.
    const dir = makeProject({ withoutDocument: true });
    try {
      expect(existsSync(join(dir, ".git", "hooks", "pre-commit"))).toBe(false);
    } finally {
      removeProject(dir);
    }
  });
});
