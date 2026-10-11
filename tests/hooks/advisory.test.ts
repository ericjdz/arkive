import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { preCompact } from "../../src/hooks/pre-compact.js";
import { stop } from "../../src/hooks/stop.js";
import { executeHook } from "../../src/hooks/main.js";
import {
  cleanProject,
  inconclusiveProject,
  makeProject,
  projectWithDanglingEdge,
  removeProject,
} from "./fixtures.js";

/**
 * `pre-compact` and `stop`: the two advisory hooks.
 *
 * Issue 0011 §2 asks `Stop` to "exit non-zero to block completion on critical
 * drift". ADR-0005 rejects that and supersedes it, and the rejection is right on
 * Claude Code's own terms — a blocking `Stop` prevents the agent from ending its
 * turn, which produces loops. These tests pin the advisory behaviour, and the
 * loop guard in particular, so the decision cannot be quietly reversed later.
 */

function recursiveHash(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        entries.push(`${full}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return createHash("sha256").update(entries.sort().join("\n")).digest("hex");
}

describe("stop reports rather than blocks", () => {
  it("never returns a blocking decision, whatever the drift", () => {
    const dir = projectWithDanglingEdge();
    try {
      const result = stop({ cwd: dir });
      expect(result.block).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.reason).toBeNull();
      expect(result.context).toContain("dangling-edge");
    } finally {
      removeProject(dir);
    }
  });

  it("says nothing at all on a clean project", () => {
    // Injecting "still fine" on every turn is how a hook gets ignored.
    const dir = cleanProject();
    try {
      const result = stop({ cwd: dir });
      expect(result.context).toBeNull();
      expect(result.notes).toEqual([]);
    } finally {
      removeProject(dir);
    }
  });

  it("stays silent when the turn is already continuing because of this hook", () => {
    // The loop guard, and the reason `stop_hook_active` is in the contract.
    // Claude Code caps consecutive continuations at eight and then ends the turn
    // regardless, so a document that cannot be fixed would otherwise produce
    // eight identical reports and then the same one on the next turn — which
    // reads as nagging rather than reporting.
    const dir = projectWithDanglingEdge();
    try {
      const first = stop({ cwd: dir, stopHookActive: false });
      expect(first.context).not.toBeNull();
      const second = stop({ cwd: dir, stopHookActive: true });
      expect(second.context).toBeNull();
      expect(second.notes).toEqual([]);
    } finally {
      removeProject(dir);
    }
  });

  it("names the concrete gap rather than saying 'drift detected'", () => {
    // "Drift detected" is a category; the agent needs the edge id, because that
    // is what it has to go and look at.
    const dir = projectWithDanglingEdge();
    try {
      const context = stop({ cwd: dir }).context ?? "";
      expect(context).toContain("calls:api->payments");
      expect(context).toContain("arkive reconcile");
      expect(context).toContain("record_decision");
    } finally {
      removeProject(dir);
    }
  });
});

describe("stop separates a verdict from a limit", () => {
  it("says a coverage gap is not a clean bill of health", () => {
    const dir = inconclusiveProject();
    try {
      const result = stop({ cwd: dir });
      expect(result.context).not.toBeNull();
      expect(result.inconclusive).toBe(true);
      expect(result.context).toMatch(/not a clean bill of health/i);
      expect(result.context).toContain("incomplete-scan");
    } finally {
      removeProject(dir);
    }
  });
});

describe("pre-compact carries the record across the memory boundary", () => {
  it("reports what is unresolved at the moment memory is about to be lost", () => {
    const dir = projectWithDanglingEdge();
    try {
      const context = preCompact({ cwd: dir, trigger: "auto" }).context ?? "";
      expect(context).toContain("Architecture state immediately before compaction");
      expect(context).toContain("dangling-edge");
      // It must state the fix, because after compaction the agent will not
      // remember being told.
      expect(context).toMatch(/record_decision|arkive reconcile/);
    } finally {
      removeProject(dir);
    }
  });

  it("says nothing on a clean project", () => {
    const dir = cleanProject();
    try {
      expect(preCompact({ cwd: dir, trigger: "manual" }).context).toBeNull();
    } finally {
      removeProject(dir);
    }
  });

  it("never blocks, because a blocked compaction is a failed request", () => {
    const dir = projectWithDanglingEdge();
    try {
      const result = preCompact({ cwd: dir });
      expect(result.block).toBe(false);
      expect(result.exitCode).toBe(0);
    } finally {
      removeProject(dir);
    }
  });

  it("warns without changing anything when the record cannot be read", () => {
    const dir = makeProject({ brokenDocument: true });
    try {
      const result = preCompact({ cwd: dir });
      expect(result.context).toBeNull();
      expect(result.inconclusive).toBe(true);
      expect(result.notes.join("\n")).toContain("could not be read");
    } finally {
      removeProject(dir);
    }
  });
});

describe("the advisory hooks write nothing", () => {
  it("leaves the tree byte-identical, including when reporting a critical", () => {
    // ADR-0005 permits writes at pre-compact and stop. This implementation does
    // not make them, deliberately: the only thing worth writing is a derived
    // delta (issue 0005, not yet landed), and fabricating one is worse than a
    // stale record because a fabrication reads as fact.
    const dir = projectWithDanglingEdge();
    try {
      const before = recursiveHash(dir);
      preCompact({ cwd: dir });
      stop({ cwd: dir });
      expect(recursiveHash(dir)).toBe(before);
    } finally {
      removeProject(dir);
    }
  });
});

describe("the harness wire format for the advisory hooks", () => {
  it("uses additionalContext, which is feedback rather than a hook error", () => {
    const dir = projectWithDanglingEdge();
    try {
      const out: string[] = [];
      executeHook("stop", {
        stdin: JSON.stringify({ cwd: dir, hook_event_name: "Stop" }),
        stdout: (text) => out.push(text),
        stderr: () => {},
        cwd: dir,
      });
      const payload = JSON.parse(out.join(""));
      // No top-level `decision: "block"`. That field prevents the agent from
      // ending its turn; ADR-0005 rejects it explicitly.
      expect(payload.decision).toBeUndefined();
      expect(payload.hookSpecificOutput.hookEventName).toBe("Stop");
      expect(payload.hookSpecificOutput.additionalContext).toContain("dangling-edge");
    } finally {
      removeProject(dir);
    }
  });

  it("reads stop_hook_active out of the harness payload", () => {
    const dir = projectWithDanglingEdge();
    try {
      const out: string[] = [];
      executeHook("stop", {
        stdin: JSON.stringify({ cwd: dir, stop_hook_active: true }),
        stdout: (text) => out.push(text),
        stderr: () => {},
        cwd: dir,
      });
      expect(out.join("")).toBe("");
    } finally {
      removeProject(dir);
    }
  });
});
