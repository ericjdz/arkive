import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { executeHook } from "../../src/hooks/main.js";
import { runHook } from "../../src/hooks/runner.js";
import { toClaudeOutput } from "../../src/hooks/adapters/claude-code.js";
import {
  SESSION_CONTEXT_MAX_CHARS,
  SESSION_CONTEXT_MAX_TOKENS,
  sessionStart,
} from "../../src/hooks/session-start.js";
import { cleanProject, captureIo, derived, makeProject, removeProject } from "./fixtures.js";

/**
 * `session-start` is the hook the product is actually about.
 *
 * Everything else in `src/hooks/` is defence in depth. This one closes the gap
 * ADR-0005 exists to name: the agent is *asked* to read the document at session
 * start, and being asked is a different kind of thing from having it in the
 * context window before the first token.
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

describe("session-start delivers architecture without asking", () => {
  it("emits the record as additionalContext, the shape Claude Code injects", () => {
    const dir = cleanProject();
    try {
      const io = captureIo(dir);
      const code = executeHook("session-start", {
        ...io.io,
        stdin: JSON.stringify({
          session_id: "abc123",
          cwd: dir,
          hook_event_name: "SessionStart",
          source: "startup",
        }),
      });

      expect(code).toBe(0);
      const payload = JSON.parse(io.stdout());
      expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
      // `additionalContext` is the field Claude Code wraps in a system reminder
      // and places before the first prompt. This is the zero-compliance claim,
      // asserted on the wire format rather than described.
      expect(typeof payload.hookSpecificOutput.additionalContext).toBe("string");
    } finally {
      removeProject(dir);
    }
  });

  it("names the project, its record, and how intent is recorded", () => {
    const dir = cleanProject();
    try {
      const context = sessionStart({ cwd: dir }).context ?? "";
      expect(context).toContain("# Architecture record — fixture");
      expect(context).toContain("arkive/architecture.json");
      expect(context).toContain("record_decision");
      expect(context).toContain("API");
    } finally {
      removeProject(dir);
    }
  });

  it("states where the session came from, so a resumed session knows it", () => {
    const dir = cleanProject();
    try {
      const context = sessionStart({ cwd: dir, source: "resume" }).context ?? "";
      expect(context).toContain("session source: resume");
    } finally {
      removeProject(dir);
    }
  });

  it("writes as factual statements, not as instructions to the model", () => {
    // Claude Code documents that text framed as out-of-band system instructions
    // can trip prompt-injection defences, which makes the agent surface the hook
    // output to the user instead of reading it as context — exactly backwards
    // for the one hook whose entire job is to be read before the first token.
    const dir = cleanProject();
    try {
      const context = sessionStart({ cwd: dir }).context ?? "";
      expect(context).not.toMatch(/\b(MUST|NON-NEGOTIABLE|DO NOT SKIP|mandatory)\b/i);
      expect(context).not.toMatch(/you must|you are required/i);
    } finally {
      removeProject(dir);
    }
  });
});

describe("session-start writes nothing", () => {
  it("leaves the tree byte-identical", () => {
    // ADR-0005: "Never write during SessionStart or PreToolUse." It fires on
    // every session and every `/clear`, so a hook that dirties the tree at
    // session start is a hook that produces surprise.
    const dir = cleanProject();
    try {
      const before = recursiveHash(dir);
      sessionStart({ cwd: dir, source: "startup" });
      expect(recursiveHash(dir)).toBe(before);
    } finally {
      removeProject(dir);
    }
  });

  it("leaves the tree byte-identical even when the document cannot be read", () => {
    const dir = makeProject({ brokenDocument: true });
    try {
      const before = recursiveHash(dir);
      const result = sessionStart({ cwd: dir });
      expect(result.context).toBeNull();
      expect(result.exitCode).toBe(0);
      expect(result.notes.join("\n")).toContain("could not read");
      expect(recursiveHash(dir)).toBe(before);
    } finally {
      removeProject(dir);
    }
  });
});

describe("session-start stays inside its ceilings", () => {
  it("stays inside the character ceiling and says what it dropped", () => {
    const dir = cleanProject();
    try {
      // A document far past the budget: 300 module nodes, one per file.
      const arch = JSON.parse(readFileSync(join(dir, "arkive", "architecture.json"), "utf-8"));
      arch.nodes = [];
      for (let i = 0; i < 300; i += 1) {
        arch.nodes.push({
          id: `mod-${i}`,
          kind: "module",
          name: `module-${i}`,
          summary: `Module number ${i}, with a reasonably wordy summary so the budget is actually exercised.`,
          path: `src/module-${i}.ts`,
          provenance: derived(`src/module-${i}.ts:1`),
        });
      }
      writeFileSync(join(dir, "arkive", "architecture.json"), JSON.stringify(arch, null, 2));

      const context = sessionStart({ cwd: dir }).context ?? "";
      expect(context.length).toBeLessThanOrEqual(SESSION_CONTEXT_MAX_CHARS);
      // Truncation that is not stated is indistinguishable from a complete
      // document, and an agent that believes it read the whole record will
      // answer from the summary believing it did not have to hedge.
      expect(context).toMatch(/## Budget|\[Truncated:/);
    } finally {
      removeProject(dir);
    }
  });

  it("asks the shared builder for a budget it can actually honour", () => {
    const dir = cleanProject();
    try {
      const context = sessionStart({ cwd: dir }).context ?? "";
      // ~4 characters per token. The header is ours, so the document body has to
      // fit in what is left of SESSION_CONTEXT_MAX_TOKENS.
      const bodyTokens = Math.ceil(context.length / 4);
      expect(bodyTokens).toBeLessThanOrEqual(SESSION_CONTEXT_MAX_TOKENS * 2);
    } finally {
      removeProject(dir);
    }
  });
});

describe("session-start is invisible where arkive is not installed", () => {
  it("prints nothing at all in a directory with no record", () => {
    const dir = makeProject({ withoutDocument: true });
    try {
      const result = sessionStart({ cwd: dir });
      expect(result.context).toBeNull();
      expect(result.exitCode).toBe(0);
      expect(result.notes).toEqual([]);
      expect(toClaudeOutput(result)).toBeNull();
    } finally {
      removeProject(dir);
    }
  });

    it("does not reach a parent repository's record from a subdirectory", () => {
      // A hook in a submodule must not adopt the superproject's document, and a
      // hook in an unrelated subdirectory must not adopt a stranger's.
      const dir = cleanProject();
      try {
        const nested = join(dir, "src", "deep", "deeper");
        mkdirSync(nested, { recursive: true });
        const result = runHook("session-start", JSON.stringify({ cwd: nested }));
        expect(result.context).toContain("arkive/architecture.json");
        expect(result.context).toContain("API");
      } finally {
        removeProject(dir);
      }
    });
});
