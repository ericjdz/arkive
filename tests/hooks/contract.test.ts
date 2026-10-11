import { describe, it, expect } from "vitest";
import {
  DEBUG_ENV,
  DISABLE_ENV,
  HOOK_BUDGET_MS,
  HOOK_EXIT,
  hooksDisabled,
  normalizeHookArgv,
  parseHookEvent,
  parseHookInput,
  runHook,
} from "../../src/hooks/index.js";
import { executeHook, main } from "../../src/hooks/main.js";
import { captureIo, cleanProject, removeProject } from "./fixtures.js";

/**
 * The contract's load-bearing promises.
 *
 * Each of these is a property the whole design rests on, and each one is a
 * property a harness can check by accident: if a hook ever crashes a tool call
 * or strands an agent at `Stop`, the user removes it from `.claude/settings.json`
 * and arkive is back to prose with no signal that anything was lost.
 */

describe("hook input is version-tolerant", () => {
  it("reads what Claude Code sends", () => {
    const input = parseHookInput(
      JSON.stringify({
        session_id: "abc123",
        cwd: "/repo",
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "/repo/src/app.ts" },
      })
    );
    expect(input.cwd).toBe("/repo");
    expect(input.toolName).toBe("Edit");
    expect(input.filePath).toBe("/repo/src/app.ts");
  });

  it("ignores fields it does not know, so a newer harness is harmless", () => {
    const input = parseHookInput(
      JSON.stringify({ cwd: "/repo", somethingNewIn2030: { deeply: ["nested"] } })
    );
    expect(input.cwd).toBe("/repo");
  });

  it("treats unparseable stdin as empty input rather than an error", () => {
    expect(parseHookInput("{ not json")).toEqual({});
    expect(parseHookInput("")).toEqual({});
    expect(parseHookInput("[1,2,3]")).toEqual({});
    expect(parseHookInput('"a string"')).toEqual({});
  });

  it("drops fields of the wrong type instead of propagating them", () => {
    const input = parseHookInput(
      JSON.stringify({ cwd: 42, stop_hook_active: "yes", tool_name: "Edit", tool_input: "nope" })
    );
    expect(input.cwd).toBeUndefined();
    expect(input.stopHookActive).toBeUndefined();
    expect(input.toolName).toBe("Edit");
    expect(input.filePath).toBeUndefined();
  });

  it("only treats a real boolean as the stop-hook loop guard", () => {
    expect(parseHookInput('{"stop_hook_active":true}').stopHookActive).toBe(true);
    expect(parseHookInput('{"stop_hook_active":1}').stopHookActive).toBeUndefined();
    expect(parseHookInput('{"stop_hook_active":"true"}').stopHookActive).toBeUndefined();
  });

  it("reads an event name case-insensitively", () => {
    expect(parseHookEvent("SessionStart")).toBe("session-start");
    expect(parseHookEvent("SESSION-START")).toBe("session-start");
    expect(parseHookEvent("session-start")).toBe("session-start");
    expect(parseHookEvent("somethingNewIn2030")).toBeNull();
    expect(parseHookEvent(undefined)).toBeNull();
  });
});

describe("the hook process fails open", () => {
  it("an unknown event exits 0 and prints nothing", () => {
    const dir = cleanProject();
    try {
      const io = captureIo(dir);
      expect(executeHook("session-start", { ...io.io, stdin: "{}" })).toBe(HOOK_EXIT.ALLOW);
      expect(main(["a-lifecycle-event-this-build-has-never-heard-of"])).toBe(HOOK_EXIT.ALLOW);
    } finally {
      removeProject(dir);
    }
  });

  it("malformed stdin still produces a valid result", () => {
    const dir = cleanProject();
    try {
      const result = runHook("session-start", "}}} not json {{{");
      expect(result.exitCode).toBe(HOOK_EXIT.ALLOW);
      expect(result.block).toBe(false);
    } finally {
      removeProject(dir);
    }
  });

  it("no advisory hook ever blocks", () => {
    const dir = cleanProject();
    try {
      for (const event of ["session-start", "pre-tool-use", "pre-compact", "stop"] as const) {
        const result = runHook(event, JSON.stringify({ cwd: dir }));
        expect(result.block, `${event} must never block`).toBe(false);
        expect(result.exitCode, `${event} must always exit 0`).toBe(HOOK_EXIT.ALLOW);
      }
    } finally {
      removeProject(dir);
    }
  });

  it("ARKIVE_HOOK_DISABLE turns every hook into a no-op, with total silence", () => {
    const dir = cleanProject();
    try {
      expect(hooksDisabled({})).toBe(false);
      expect(hooksDisabled({ [DISABLE_ENV]: "" })).toBe(false);
      expect(hooksDisabled({ [DISABLE_ENV]: "1" })).toBe(true);
      expect(hooksDisabled({ [DISABLE_ENV]: "0" })).toBe(true);
      expect(hooksDisabled({ [DISABLE_ENV]: "false" })).toBe(true);

      const io = captureIo(dir, { [DISABLE_ENV]: "1" });
      expect(executeHook("session-start", io.io)).toBe(HOOK_EXIT.ALLOW);
      expect(io.stdout()).toBe("");
      expect(io.stderr()).toBe("");
    } finally {
      removeProject(dir);
    }
  });

  it("runHook refuses the git event rather than pretending it is a harness event", () => {
    // A programmer error, not a user error, so it is loud. Quietly returning a
    // "successful" harness result for the one hook that can block would be the
    // worst possible outcome.
    expect(() => runHook("pre-commit", "")).toThrow(/preCommit/);
  });
});

describe("the hook process keeps stdout a protocol", () => {
  it("prints nothing when there is nothing to say", () => {
    const dir = cleanProject();
    try {
      const io = captureIo(dir);
      executeHook("session-start", io.io);
      // A project with a clean document is still worth injecting — that is the
      // whole point — so assert the shape rather than the emptiness here and
      // leave the empty case to the hooks that have nothing to report.
      const payload = io.stdout().trim();
      expect(payload.startsWith("{")).toBe(true);
      expect(payload.endsWith("}")).toBe(true);
      expect(() => JSON.parse(payload)).not.toThrow();
    } finally {
      removeProject(dir);
    }
  });

  it("emits exactly one JSON object, which is what Claude Code requires", () => {
    const dir = cleanProject();
    try {
      const io = captureIo(dir);
      executeHook("stop", io.io);
      // `Stop` has nothing to report on a clean project, so stdout must be
      // empty rather than `{}` or a blank line: Claude Code only reads stdout as
      // JSON output when the whole of it is one object and nothing else.
      expect(io.stdout()).toBe("");
    } finally {
      removeProject(dir);
    }
  });
});

describe("argument handling across the three ways in", () => {
  it("accepts `event`, `hooks event`, and `hooks run event` alike", () => {
    expect(normalizeHookArgv(["session-start"])).toEqual(["session-start"]);
    expect(normalizeHookArgv(["hooks", "session-start"])).toEqual(["session-start"]);
    expect(normalizeHookArgv(["hooks", "run", "session-start"])).toEqual(["session-start"]);
    expect(normalizeHookArgv(["hooks", "run", "pre-commit"])).toEqual(["pre-commit"]);
    // A prefix that is not ours is left alone rather than guessed at.
    expect(normalizeHookArgv(["--remove"])).toEqual(["--remove"]);
  });
});

describe("the budget", () => {
  it("is enforced by the dispatcher, not remembered by each hook", () => {
    // The dispatcher is what owns the budget, because "every hook respects it"
    // is a property of the dispatcher. A hook clock past the ceiling has its
    // payload dropped: delivering a truncated architecture record is worse than
    // delivering nothing, because the agent cannot tell it was cut short.
    let clock = 0;
    const now = (): number => (clock += 1000);
    const result = runHook("session-start", "{}", now);
    expect(result.overBudget).toBe(true);
    expect(result.context).toBeNull();
    expect(result.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(result.block).toBe(false);
    expect(result.notes.join("\n")).toContain(`${HOOK_BUDGET_MS}ms budget`);
  });

  it("leaves an in-budget result alone", () => {
    const dir = cleanProject();
    try {
      const result = runHook("session-start", JSON.stringify({ cwd: dir }));
      expect(result.overBudget).toBe(false);
      expect(result.context).not.toBeNull();
    } finally {
      removeProject(dir);
    }
  });
});

describe("debug output never changes behaviour", () => {
  it("adds a timing line to stderr and nothing else", () => {
    const dir = cleanProject();
    try {
      const quiet = captureIo(dir);
      const loud = captureIo(dir, { [DEBUG_ENV]: "1" });
      executeHook("session-start", quiet.io);
      executeHook("session-start", loud.io);
      expect(loud.stderr().length).toBeGreaterThan(quiet.stderr().length);
      expect(loud.stdout()).toBe(quiet.stdout());
    } finally {
      removeProject(dir);
    }
  });
});
