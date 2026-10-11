import { describe, it, expect } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { preCommit } from "../../src/hooks/pre-commit.js";
import { executeHook } from "../../src/hooks/main.js";
import { COVERAGE_KINDS, partitionCritical, verifyProject } from "../../src/hooks/index.js";
import { readArchitecture, writeArchitecture } from "../../src/io/architecture-file.js";
import {
  cleanProject,
  inconclusiveProject,
  makeProject,
  projectWithDanglingEdge,
  removeProject,
  authored,
} from "./fixtures.js";

/**
 * The one hook that can prevent anything.
 *
 * Every test here is really one question asked two ways: **does this condition
 * mean the document is wrong, or does it mean arkive could not look?** Getting
 * that backwards in one direction produces a gate nobody can use, and in the
 * other produces a gate that certifies documents it never read.
 */

describe("critical drift blocks", () => {
  it("refuses a commit whose record asserts an edge that resolves to nothing", () => {
    const dir = projectWithDanglingEdge();
    try {
      const result = preCommit(dir);
      expect(result.block).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.reason).toContain("dangling-edge");
      expect(result.reason).toContain("calls:api->payments");
    } finally {
      removeProject(dir);
    }
  });

  it("prints exactly what is wrong and exactly how to get past it", () => {
    // The ADR requires this: a gate that prints "blocked" gets `--no-verify`d
    // by reflex and then enforces nothing ever again.
    const dir = projectWithDanglingEdge();
    try {
      const reason = preCommit(dir).reason ?? "";
      expect(reason).toContain("git commit --no-verify");
      expect(reason).toContain("arkive hooks --remove");
      expect(reason).toContain("record_decision");
      expect(reason).toMatch(/\(dangling-edge\)/);
      expect(reason).toMatch(/Scan coverage:/);
    } finally {
      removeProject(dir);
    }
  });

  it("allows a commit once the drift is gone", () => {
    const dir = projectWithDanglingEdge();
    try {
      expect(preCommit(dir).block).toBe(true);

      const read = readArchitecture(dir);
      if (!read.success) throw new Error(read.error);
      read.data.edges = read.data.edges.filter((edge) => edge.dangling !== true);
      // The v1 `connections[]` view is folded back onto the graph on write, so
      // it has to lose the connection too or the write resurrects the edge.
      read.data.connections = read.data.connections.filter(
        (connection) => !(connection.from === "api" && connection.to === "payments")
      );
      const written = writeArchitecture(dir, read.data);
      if (!written.success) throw new Error(written.error);

      const after = preCommit(dir);
      expect(after.block).toBe(false);
      expect(after.exitCode).toBe(0);
      expect(after.context).toBeNull();
    } finally {
      removeProject(dir);
    }
  });

  it("does not gate on warning-severity drift", () => {
    // The tolerance is "critical", named and deliberate. A gate that blocks on
    // `stale-stack` would refuse commits over an entry in `architecture.stack`
    // that names a package version rather than a package.
    const dir = cleanProject();
    try {
      const result = preCommit(dir);
      expect(result.block).toBe(false);
    } finally {
      removeProject(dir);
    }
  });
});

describe("an inconclusive scan does not block", () => {
  // The single most important behaviour in this file. `drift.ts` marks
  // `incomplete-scan` and `missing-manifest` as `critical`, which is right for a
  // report and wrong for a gate: those say "arkive could not look", not "the
  // document is wrong". Honouring them would block commits for a reason the user
  // cannot act on — and, on this repository, would block every commit because
  // two files in it are in a language the scanner cannot parse.
  it("allows the commit", () => {
    const dir = inconclusiveProject();
    try {
      const outcome = verifyProject(dir);
      expect(outcome.inconclusive).toBe(true);
      expect(outcome.coverageGaps.length).toBeGreaterThan(0);
      expect(outcome.coverageGaps[0].kind).toBe("incomplete-scan");

      const result = preCommit(dir);
      expect(result.block).toBe(false);
      expect(result.exitCode).toBe(0);
    } finally {
      removeProject(dir);
    }
  });

  it("says so on stderr every single time", () => {
    // The gate did not fire because it has no finding to act on, not because it
    // found nothing. Those two must never look the same in a commit log.
    const dir = inconclusiveProject();
    try {
      const err: string[] = [];
      const code = executeHook("pre-commit", {
        stdin: "",
        stdout: () => {},
        stderr: (text) => err.push(text),
        cwd: dir,
      });
      expect(code).toBe(0);
      const notes = err.join("");
      expect(notes).toContain("could not verify this commit");
      expect(notes).toContain("not a clean bill of health");
      expect(notes).toContain("incomplete-scan");
    } finally {
      removeProject(dir);
    }
  });

  it("still blocks on a document defect found under a partial scan", () => {
    // `dangling-edge` is a statement about the *document* — it asserts a
    // relationship that resolves to nothing — and it is exactly as true under a
    // partial scan as under a complete one.
    const dir = makeProject({
      files: {
        "app.ts": 'import express from "express";\nexport const app = express();\n',
        "deploy.sh": "#!/bin/sh\necho deploy\n",
      },
      danglingEdge: true,
    });
    try {
      const outcome = verifyProject(dir);
      expect(outcome.coverageGaps.length).toBeGreaterThan(0);
      expect(outcome.blocking.length).toBeGreaterThan(0);
      expect(preCommit(dir).block).toBe(true);
    } finally {
      removeProject(dir);
    }
  });
});

describe("coverage kinds are exactly the two that describe arkive's own limits", () => {
  it("are partitioned out of the gate and kept in the report", () => {
    expect([...COVERAGE_KINDS].sort()).toEqual(["incomplete-scan", "missing-manifest"]);

    const report = {
      conclusive: false,
      warnings: [
        { kind: "incomplete-scan" as const, severity: "critical" as const, subject: "s", message: "m", suggestion: "" },
        { kind: "dangling-edge" as const, severity: "critical" as const, subject: "e", message: "m", suggestion: "" },
        { kind: "stale-stack" as const, severity: "warning" as const, subject: "r", message: "m", suggestion: "" },
      ],
      summary: { total: 3, bySeverity: { info: 0, warning: 1, critical: 2 }, byKind: {} as never },
    };
    const { blocking, coverageGaps } = partitionCritical(report);
    expect(blocking.map((w) => w.kind)).toEqual(["dangling-edge"]);
    expect(coverageGaps.map((w) => w.kind)).toEqual(["incomplete-scan"]);
  });
});

describe("a missing record is a gate failure, not a hook failure", () => {
  // A git hook lives in `.git/hooks/`, which is not committed, so it only exists
  // in a checkout where somebody ran `arkive hooks`. If the record is gone from
  // such a checkout, something removed it — which is commit 62066bc's failure
  // class — and the gate is the only thing standing between that and a commit
  // that records the loss.
  it("blocks when the record is gone from a checkout that opted in", () => {
    const dir = makeProject({ withoutDocument: true });
    try {
      const result = preCommit(dir);
      expect(result.block).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.reason).toContain("missing");
      expect(result.reason).toContain("--no-verify");
      expect(result.reason).toContain("hooks --remove");
    } finally {
      removeProject(dir);
    }
  });

  it("stays silent outside a git repository entirely", () => {
    const dir = makeProject({ withoutDocument: true, gitRepo: false });
    try {
      const result = preCommit(dir);
      expect(result.block).toBe(false);
      expect(result.exitCode).toBe(0);
    } finally {
      removeProject(dir);
    }
  });

  it("blocks when the record exists but cannot be parsed", () => {
    const dir = makeProject({ brokenDocument: true });
    try {
      const result = preCommit(dir);
      expect(result.block).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.reason).toContain("could not be read");
      expect(result.reason).toContain("--no-verify");
    } finally {
      removeProject(dir);
    }
  });

  it("blocks on a record that fails schema validation, not just unparseable JSON", () => {
    const dir = cleanProject();
    try {
      writeFileSync(
        join(dir, "arkive", "architecture.json"),
        JSON.stringify({
          schemaVersion: 2,
          project: { name: "x", description: "", created: "2026-01-01T00:00:00.000Z", lastUpdated: "2026-01-01T00:00:00.000Z" },
          stack: { language: [], runtime: [], framework: [], database: [], infrastructure: [] },
          nodes: [{ id: "a", kind: "module", name: "a", summary: "x", provenance: authored() }],
          edges: [{ id: "e", from: "a", to: "ghost", kind: "imports", provenance: authored() }],
          decisions: [],
          dataFlows: [],
          history: [],
        })
      );
      const result = preCommit(dir);
      expect(result.block).toBe(true);
      expect(result.exitCode).toBe(1);
    } finally {
      removeProject(dir);
    }
  });
});

describe("the gate never blocks for a reason of its own", () => {
  it("writes nothing to stdout — that channel belongs to git", () => {
    const dir = projectWithDanglingEdge();
    try {
      const out: string[] = [];
      executeHook("pre-commit", {
        stdin: "",
        stdout: (text) => out.push(text),
        stderr: () => {},
        cwd: dir,
      });
      expect(out.join("")).toBe("");
    } finally {
      removeProject(dir);
    }
  });

  it("does not modify the working tree", () => {
    const dir = projectWithDanglingEdge();
    try {
      const before = readFileSyncOrNull(join(dir, "arkive", "architecture.json"));
      preCommit(dir);
      expect(readFileSyncOrNull(join(dir, "arkive", "architecture.json"))).toBe(before);
    } finally {
      removeProject(dir);
    }
  });
});

function readFileSyncOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

describe("verifyProject never throws", () => {
  it("reports a broken record rather than propagating a Zod error", () => {
    const dir = makeProject({ brokenDocument: true });
    try {
      const outcome = verifyProject(dir);
      expect(outcome.status).toBe("unreadable");
      expect(outcome.error).toBeTruthy();
      expect(outcome.blocking).toEqual([]);
    } finally {
      removeProject(dir);
    }
  });

  it("reports an absent record as absent, not as an error", () => {
    const dir = makeProject({ withoutDocument: true });
    try {
      const outcome = verifyProject(dir);
      expect(outcome.status).toBe("absent");
      expect(outcome.error).toBeNull();
      expect(outcome.inconclusive).toBe(false);
    } finally {
      removeProject(dir);
    }
  });

  it("survives a directory that has been deleted underneath it", () => {
    const dir = cleanProject();
    try {
      rmSync(dir, { recursive: true, force: true });
      expect(() => verifyProject(dir)).not.toThrow();
      expect(preCommit(dir).exitCode).toBe(0);
    } finally {
      removeProject(dir);
    }
  });
});
