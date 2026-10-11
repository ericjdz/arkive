import type { HookEvent, HookResult } from "../contract.js";
import { HOOK_EVENTS } from "../contract.js";

/**
 * Claude Code adapter.
 *
 * The only module in `src/hooks/` that knows Claude Code exists. It maps
 * {@link HookResult} onto the wire shapes documented at
 * `https://code.claude.com/docs/en/hooks`, and deliberately contains no logic:
 * every decision about *what* to say has already been made, and every decision
 * about *whether* to say it is the harness's, not arkive's.
 *
 * Keeping this mapping total and mechanical is what makes the contract portable.
 * A second adapter is a second file that translates the same `HookResult` and
 * touches none of the hooks.
 */

/** The Claude Code event name for each contract event. */
export const CLAUDE_EVENT: Record<HookEvent, string> = {
  "session-start": "SessionStart",
  "pre-tool-use": "PreToolUse",
  "pre-compact": "PreCompact",
  stop: "Stop",
  "pre-commit": "PreCommit",
};

export interface ClaudeHookHandler {
  type: "command";
  /** Shell form: the command string is handed to `sh -c` (Git Bash on Windows). */
  command: string;
  /**
   * Seconds before Claude Code cancels the hook and discards its output.
   *
   * Set well above `HOOK_BUDGET_MS` on purpose. A hook that times out on
   * `PreToolUse` does not block the tool call — it renders no decision at all —
   * so the ceiling here is a backstop against a wedged process, not the latency
   * control. The latency control is the design of the hook itself.
   */
  timeout: number;
  /**
   * `"continue"` is the default, and it is the load-bearing part of this
   * adapter: a hook that cannot start, crashes, or times out must not stop an
   * agent from working. Stated explicitly so that changing it is a visible,
   * deliberate edit rather than an inherited default nobody read.
   */
  onFailure: "continue" | "block";
}

export interface ClaudeHookMatcherGroup {
  /** Absent means "every occurrence of the event". */
  matcher?: string;
  hooks: ClaudeHookHandler[];
}

/**
 * The command every generated hook handler runs.
 *
 * One shape for all four events, so a reader of `.claude/settings.json` can see
 * the whole arkive surface by looking at one line, and so the marker used to
 * recognise arkive's own entries on uninstall is unambiguous.
 */
export function buildHookCommand(command: string, event: HookEvent): string {
  return `${command} hooks run ${event}`;
}

/**
 * Per-event timeouts.
 *
 * `session-start` and `pre-tool-use` fire constantly and must never be the
 * reason a session feels slow. `stop` and `pre-compact` run a full scan, once
 * per turn and once per compaction, so they get more room — a scan on a large
 * repository is real work.
 */
const TIMEOUT_SECONDS: Record<HookEvent, number> = {
  "session-start": 5,
  "pre-tool-use": 5,
  "pre-compact": 30,
  stop: 30,
  "pre-commit": 30,
};

/**
 * The matcher for `PreToolUse`.
 *
 * Claude Code treats a matcher of only letters, digits, `_`, `-`, spaces, `,`
 * and `|` as an exact-match list, so this is four tool names and not a regular
 * expression. `NotebookEdit` is here because its name would not match `Edit` on
 * the exact-match path.
 */
export const FILE_EDIT_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";

export function buildMatcherGroups(event: HookEvent, command: string): ClaudeHookMatcherGroup[] {
  if (event === "pre-commit") return [];

  const handler: ClaudeHookHandler = {
    type: "command",
    command: buildHookCommand(command, event),
    timeout: TIMEOUT_SECONDS[event],
    onFailure: "continue",
  };

  const group: ClaudeHookMatcherGroup = { hooks: [handler] };
  if (event === "pre-tool-use") group.matcher = FILE_EDIT_MATCHER;
  return [group];
}

/**
 * Render a result as the JSON object Claude Code expects on stdout.
 *
 * Returns `null` when there is nothing to say. Claude Code's parsing rule is
 * that stdout is read as JSON output only when the whole of it is one JSON
 * object and nothing else, so printing an empty object or a newline is not the
 * same as printing nothing, and printing nothing is not the same as printing a
 * non-empty object with an empty field.
 *
 * `block` is honoured rather than assumed away. It is currently only ever true
 * for `pre-commit`, which is not a Claude Code event — but if a future adapter
 * routes `pre-commit` through here, the blocking path is already correct rather
 * than a bug waiting to be written.
 */
export function toClaudeOutput(result: HookResult): Record<string, unknown> | null {
  if (result.block) {
    // Claude Code reads `reason` for the blocking explanation on events that use
    // top-level `decision`, and `permissionDecisionReason` on `PreToolUse`.
    if (result.event === "pre-tool-use") {
      return {
        hookSpecificOutput: {
          hookEventName: CLAUDE_EVENT["pre-tool-use"],
          permissionDecision: "deny",
          permissionDecisionReason: result.reason ?? "arkive",
        },
      };
    }
    return { decision: "block", reason: result.reason ?? "arkive" };
  }

  if (result.context === null) return null;

  return {
    hookSpecificOutput: {
      hookEventName: CLAUDE_EVENT[result.event],
      additionalContext: result.context,
    },
  };
}

export { HOOK_EVENTS };
